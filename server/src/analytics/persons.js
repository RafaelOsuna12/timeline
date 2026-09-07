/**
 * De plazas a personas.
 *
 * El Excel trae una fila por *plaza* —tienda + asesor—, asi que un promotor
 * que cubre dos tiendas aparece dos veces. Sumar esas filas tal cual infla el
 * conteo de promotores del supervisor y del CM, y duplica los dias asistidos
 * cuando la persona estuvo en ambas tiendas el mismo dia.
 *
 * Aqui se agrupan las plazas de una misma persona en un solo registro con la
 * misma forma que una plaza, de modo que el resto del sistema —metricas,
 * jerarquia, alertas— siga trabajando igual sin saber si detras hay una tienda
 * o tres.
 *
 * Reglas de agregacion:
 *   - ventas y targets: se suman (una venta en cada tienda son dos ventas);
 *   - asistencia: es un dia trabajado, no dos, aunque cubra dos tiendas;
 *   - dias en cero: el dia cuenta como en cero solo si no vendio en ninguna.
 */
const zeros = (n) => new Array(n).fill(0);

/**
 * Nombres que no identifican a una persona: son plazas sin titular. Nunca se
 * agrupan entre si, porque diez "VACANCY" son diez vacantes distintas y no una
 * persona con diez tiendas.
 */
const PLACEHOLDER = /^(VACANCY|VACANTE|SIN\s+ASESOR|SIN\s+ASIGNAR|POR\s+ASIGNAR|N\/?A|PENDIENTE)/i;

export function isPlaceholderName(name) {
  return !name || PLACEHOLDER.test(String(name).trim());
}

/**
 * Clave de persona de una plaza. Se usa el nombre del asesor: es lo unico que
 * identifica a la persona en el reporte (la columna DOUBLE ADVISOR viene en
 * cero para todos). Las plazas sin titular reciben una clave propia.
 */
export function personKeyOf(row) {
  if (isPlaceholderName(row.advisor)) return `@plaza:${row.id}`;
  return row.advisorKey || String(row.advisor).trim().toUpperCase();
}

/** La plaza principal es la BASE; si no hay, la de mayor target y luego venta. */
function mainPlacement(items) {
  const score = (p) => [
    p.status === 'BASE' ? 2 : p.status === 'SUPPORT' ? 1 : 0,
    p.targetHQ || 0,
    p.daily.soTarget.reduce((a, b) => a + b, 0),
  ];
  return items.reduce((best, p) => {
    const a = score(p);
    const b = score(best);
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i] ? p : best;
    }
    return best;
  }, items[0]);
}

function addInto(target, series) {
  if (!series) return;
  for (let i = 0; i < target.length; i += 1) target[i] += series[i] || 0;
}

/**
 * Agrupa plazas en personas.
 *
 * Es idempotente: una lista ya agrupada vuelve tal cual, y una plaza sola se
 * devuelve sin tocar, de modo que ningun numero de los promotores de una sola
 * tienda cambia al pasar por aqui.
 *
 * @param {Array} rows plazas (o personas ya agrupadas)
 * @param {number} days dias del mes
 * @returns {Array} un registro por persona
 */
export function collapsePersons(rows, days) {
  if (!rows || rows.length < 2) return rows || [];

  const groups = new Map();
  for (const row of rows) {
    const k = personKeyOf(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  if (groups.size === rows.length) return rows; // nadie repite: nada que agrupar

  const out = [];
  for (const items of groups.values()) {
    out.push(items.length === 1 ? items[0] : mergePlacements(items, days));
  }
  return out;
}

function mergePlacements(items, days) {
  const main = mainPlacement(items);
  const n = days || main.daily.soTarget.length;

  const soTarget = zeros(n);
  const soAll = zeros(n);
  const soIot = zeros(n);
  const presence = zeros(n);
  const models = {};
  const modelDaily = {};

  let targetHQ = 0;
  let targetAdjusted = 0;
  let targetInitial = 0;

  for (const p of items) {
    addInto(soTarget, p.daily.soTarget);
    addInto(soAll, p.daily.soAll);
    addInto(soIot, p.daily.soIot);
    addInto(presence, p.daily.attendance);
    targetHQ += p.targetHQ || 0;
    targetAdjusted += p.targetAdjusted || 0;
    targetInitial += p.targetInitial || 0;
    for (const [m, v] of Object.entries(p.models || {})) models[m] = (models[m] || 0) + (v || 0);
    for (const [m, series] of Object.entries(p.modelDaily || {})) {
      if (!modelDaily[m]) modelDaily[m] = zeros(n);
      addInto(modelDaily[m], series);
    }
  }

  // Un dia cubierto en dos tiendas sigue siendo un dia trabajado, y solo es un
  // dia en cero si no hubo venta en ninguna de ellas.
  const attendance = zeros(n);
  const zeroSale = zeros(n);
  for (let i = 0; i < n; i += 1) {
    attendance[i] = presence[i] > 0 ? 1 : 0;
    zeroSale[i] = attendance[i] && soTarget[i] === 0 ? 1 : 0;
  }

  const placements = [...items].sort((a, b) => (a === main ? -1 : b === main ? 1 : 0));

  return {
    ...main,
    id: main.id,
    personKey: personKeyOf(main),
    targetInitial,
    targetAdjusted,
    targetHQ,
    models,
    modelDaily,
    daily: { soTarget, soAll, soIot, attendance, zeroSale },
    placements,
    storeCount: placements.length,
    stores: placements.map((p) => p.store),
    channels: [...new Set(placements.map((p) => p.channel))],
  };
}

/**
 * Desglose por tienda de una persona, para su ficha individual.
 * Devuelve siempre al menos una entrada, tambien para quien tiene una sola.
 */
export function placementBreakdown(person, ctx) {
  const items = person.placements || [person];
  const upto = (s) => (s || []).slice(0, ctx.cutoffDay).reduce((a, b) => a + (b || 0), 0);
  const totalSo = items.reduce((a, p) => a + upto(p.daily.soTarget), 0);

  return items.map((p) => {
    const so = upto(p.daily.soTarget);
    const worked = upto(p.daily.attendance);
    return {
      key: p.id,
      store: p.store,
      channel: p.channel,
      region: p.region,
      supervisor: p.supervisor,
      employment: p.status,
      target: p.targetHQ || 0,
      so,
      soAll: upto(p.daily.soAll),
      soIot: upto(p.daily.soIot),
      workedDays: worked,
      zeroDays: upto(p.daily.zeroSale),
      productivity: worked ? so / worked : null,
      share: totalSo ? so / totalSo : null,
      daily: p.daily.soTarget.slice(0, ctx.daysInMonth),
      attendance: p.daily.attendance.slice(0, ctx.daysInMonth),
    };
  });
}
