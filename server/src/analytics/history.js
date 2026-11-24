/**
 * Historial por persona a traves de varios meses.
 *
 * El resto del tablero trabaja sobre un snapshot —un mes—; aqui se recorren
 * varios y se arma la linea de tiempo de un promotor o de un supervisor: que
 * meta tuvo cada mes, cuanto vendio, cuanto le falto y como se movio.
 *
 * Los numeros salen de las mismas funciones que el tablero (`computeMetrics`
 * sobre el snapshot cargado) y no de un atajo contra la base. Es algo mas
 * lento, pero garantiza que un numero impreso aqui coincida con el mismo
 * numero en pantalla: las reglas de negocio —plazas OFFLINE fuera, una
 * persona con dos tiendas cuenta una vez, un dia cubriendo dos tiendas es un
 * dia trabajado— viven en ese motor y no se reimplementan.
 *
 * El enlace entre meses es el **nombre**: la llave interna de un promotor
 * incluye su tienda, asi que cambiar de tienda cambiaria la llave y partiria
 * su historia en dos.
 */
import { db } from '../db.js';
import { computeMetrics, round, statusOf } from './metrics.js';
import { collapsePersons, personKeyOf } from './persons.js';
import { contextOf, filterPromoters } from './views.js';
import { loadSnapshot } from './snapshot.js';
import { tenureMonths } from './headcount.js';

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function periodLabel(periodKey) {
  const [y, m] = String(periodKey).split('-').map(Number);
  if (!y || !m) return periodKey;
  const name = MONTHS[m - 1] || '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

const nameKey = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

/* ------------------------------- periodos ------------------------------- */

/**
 * Meses disponibles, uno por periodo con archivo cargado.
 *
 * De cada mes se toma la carga de corte mas avanzado, que es la que mas se
 * acerca al cierre. Un mes esta completo cuando ese corte llega al ultimo dia;
 * si no, compararlo contra meses cerrados se leeria como una caida de ventas
 * que en realidad es un mes a medias.
 */
export function listPeriods() {
  const rows = db
    .prepare(
      `SELECT period_key, days_in_month, cutoff_day, id, created_at
         FROM snapshots
        ORDER BY period_key DESC, cutoff_day DESC, created_at DESC`
    )
    .all();

  const best = new Map();
  for (const r of rows) if (!best.has(r.period_key)) best.set(r.period_key, r);

  return [...best.values()]
    .map((r) => ({
      periodKey: r.period_key,
      label: periodLabel(r.period_key),
      snapshotId: r.id,
      cutoffDay: r.cutoff_day,
      daysInMonth: r.days_in_month,
      complete: r.cutoff_day >= r.days_in_month,
      createdAt: r.created_at,
    }))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey));
}

/* -------------------------------- personas ------------------------------- */

/**
 * Catalogo de promotores y supervisores presentes en los meses dados.
 * Se agrega en cuantos de esos meses aparece cada uno, que es lo que permite
 * saber de antemano si una hoja va a salir con huecos.
 */
export function listHistoryPeople(periodKeys = []) {
  const periods = listPeriods().filter((p) => !periodKeys.length || periodKeys.includes(p.periodKey));
  const promoters = new Map();
  const supervisors = new Map();

  for (const period of periods) {
    const snap = loadSnapshot(period.snapshotId);
    if (!snap) continue;
    const rows = filterPromoters(snap.promoters, {});

    for (const person of collapsePersons(rows, snap.meta.daysInMonth)) {
      const key = personKeyOf(person);
      if (!promoters.has(key)) {
        promoters.set(key, { kind: 'promotor', key, name: person.advisor, months: 0 });
      }
      const e = promoters.get(key);
      e.months += 1;
      e.name = person.advisor;
      e.region = person.region;
      e.store = person.store;
      e.supervisor = person.supervisor;
      e.cm = person.cm;
    }

    for (const row of rows) {
      if (!row.supervisor) continue;
      const key = nameKey(row.supervisor);
      if (!supervisors.has(key)) {
        supervisors.set(key, { kind: 'supervisor', key, name: row.supervisor, months: 0, seen: new Set() });
      }
      const e = supervisors.get(key);
      if (!e.seen.has(period.periodKey)) {
        e.seen.add(period.periodKey);
        e.months += 1;
      }
      e.name = row.supervisor;
      e.region = row.region;
      e.cm = row.cm;
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'es');
  return {
    periods,
    promoters: [...promoters.values()].sort(byName),
    supervisors: [...supervisors.values()].map(({ seen, ...rest }) => rest).sort(byName),
  };
}

/* -------------------------------- historial ------------------------------ */

/** Fecha de ingreso de la ultima carga de plantilla, por nombre. */
function hireDates() {
  const row = db.prepare("SELECT id FROM hc_snapshots WHERE status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1").get();
  if (!row) return new Map();
  const people = db.prepare('SELECT name_key, hire_date FROM hc_people WHERE snapshot_id = ? AND hire_date IS NOT NULL').all(row.id);
  return new Map(people.map((p) => [p.name_key, p.hire_date]));
}

/** Bloque de un mes, con lo que se imprime y nada mas. */
function monthBlock(period, metrics, extra = {}) {
  if (!metrics) {
    return { periodKey: period.periodKey, label: period.label, present: false, complete: period.complete };
  }
  return {
    periodKey: period.periodKey,
    label: period.label,
    present: true,
    complete: period.complete,
    cutoffDay: period.cutoffDay,
    daysInMonth: period.daysInMonth,
    target: metrics.target,
    so: metrics.so,
    soAll: metrics.soAll,
    ach: metrics.ach,
    gap: metrics.gap,
    attendanceDays: metrics.attendanceDays,
    zeroSaleDays: metrics.zeroSaleDays,
    productivity: metrics.productivity,
    dailyAvg: metrics.dailyAvg,
    status: metrics.status,
    ...extra,
  };
}

/**
 * Construye el historial de las personas pedidas.
 *
 * @param {object} selection  { periods:[], promoters:[], supervisors:[] }
 */
export function buildHistory(selection = {}) {
  const wantedPeriods = (selection.periods || []).filter(Boolean);
  const periods = listPeriods().filter((p) => !wantedPeriods.length || wantedPeriods.includes(p.periodKey));
  const promoterKeys = new Set((selection.promoters || []).map(nameKey));
  const supervisorKeys = new Set((selection.supervisors || []).map(nameKey));
  const hires = hireDates();

  // Un acumulador por persona; se va llenando mes a mes.
  const people = new Map();
  const touch = (kind, key, name) => {
    const id = `${kind}:${key}`;
    if (!people.has(id)) {
      people.set(id, { id, kind, key, name, months: new Map(), latest: null });
    }
    const e = people.get(id);
    e.name = name || e.name;
    return e;
  };

  for (const period of periods) {
    const snap = loadSnapshot(period.snapshotId);
    if (!snap) continue;
    const ctx = contextOf(snap, {});
    const rows = filterPromoters(snap.promoters, {});

    if (promoterKeys.size) {
      for (const person of collapsePersons(rows, snap.meta.daysInMonth)) {
        const key = personKeyOf(person);
        if (!promoterKeys.has(key)) continue;
        const m = computeMetrics(ctx, [person], {});
        const entry = touch('promotor', key, person.advisor);
        entry.months.set(
          period.periodKey,
          monthBlock(period, m, { storeCount: person.storeCount || 1, stores: person.stores || [person.store] })
        );
        entry.latest = {
          region: person.region,
          cm: person.cm,
          supervisor: person.supervisor,
          store: person.store,
          channel: person.channel,
          employment: person.status,
        };
      }
    }

    if (supervisorKeys.size) {
      const bySupervisor = new Map();
      for (const row of rows) {
        if (!row.supervisor) continue;
        const key = nameKey(row.supervisor);
        if (!supervisorKeys.has(key)) continue;
        if (!bySupervisor.has(key)) bySupervisor.set(key, { name: row.supervisor, rows: [] });
        bySupervisor.get(key).rows.push(row);
      }
      for (const [key, group] of bySupervisor) {
        const m = computeMetrics(ctx, group.rows, {});
        const entry = touch('supervisor', key, group.name);
        entry.months.set(period.periodKey, monthBlock(period, m, { headcount: m.headcount, storeCount: m.placementCount }));
        entry.latest = {
          region: group.rows[0]?.region || null,
          cm: group.rows[0]?.cm || null,
          supervisor: null,
          channel: null,
        };
      }
    }
  }

  const result = [...people.values()].map((entry) => {
    const months = periods.map((p) => entry.months.get(p.periodKey) || monthBlock(p, null));

    // La variacion se mide contra el mes anterior **con registro**: comparar
    // contra un mes en el que la persona no estaba no dice nada.
    let anterior = null;
    for (const m of months) {
      if (!m.present) continue;
      m.deltaPoints = anterior && anterior.ach !== null && m.ach !== null ? round(m.ach - anterior.ach, 4) : null;
      m.deltaPieces = anterior ? round(m.so - anterior.so, 0) : null;
      anterior = m;
    }

    const conDatos = months.filter((m) => m.present);
    const target = conDatos.reduce((a, m) => a + (m.target || 0), 0);
    const so = conDatos.reduce((a, m) => a + (m.so || 0), 0);
    const conMeta = conDatos.filter((m) => m.target > 0 && m.ach !== null);
    const mejor = conMeta.reduce((b, m) => (!b || m.ach > b.ach ? m : b), null);
    const peor = conMeta.reduce((b, m) => (!b || m.ach < b.ach ? m : b), null);
    const primero = conMeta[0] || null;
    const ultimo = conMeta[conMeta.length - 1] || null;

    const hireDate = entry.kind === 'promotor' ? hires.get(entry.key) || null : null;

    return {
      id: entry.id,
      kind: entry.kind,
      key: entry.key,
      name: entry.name,
      ...entry.latest,
      hireDate,
      tenureMonths: tenureMonths(hireDate),
      months,
      totals: {
        monthsSelected: months.length,
        monthsWithData: conDatos.length,
        target: round(target, 0),
        so: round(so, 0),
        soAll: round(conDatos.reduce((a, m) => a + (m.soAll || 0), 0), 0),
        ach: target ? round(so / target, 4) : null,
        gap: target ? round(target - so, 0) : null,
        // El promedio se reparte entre los meses con registro, no entre los
        // seleccionados: incluir un mes en el que la persona no estaba
        // hundiria el promedio sin motivo.
        monthlyAverage: conDatos.length ? round(so / conDatos.length, 1) : null,
        monthlyTarget: conDatos.length ? round(target / conDatos.length, 1) : null,
        status: statusOf(so, target),
        attendanceDays: round(conDatos.reduce((a, m) => a + (m.attendanceDays || 0), 0), 0),
        productivity: null,
        best: mejor ? { label: mejor.label, ach: mejor.ach, so: mejor.so } : null,
        worst: peor ? { label: peor.label, ach: peor.ach, so: peor.so } : null,
        trendPoints: primero && ultimo && primero !== ultimo ? round(ultimo.ach - primero.ach, 4) : null,
        firstMonth: primero?.label || null,
        lastMonth: ultimo?.label || null,
      },
    };
  });

  for (const p of result) {
    const dias = p.totals.attendanceDays;
    p.totals.productivity = dias > 0 ? round(p.totals.so / dias, 2) : null;
  }

  // Primero los supervisores y despues los promotores, cada grupo por nombre:
  // un documento mezclado se lee mejor si el equipo va antes que sus personas.
  result.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'es') : a.kind === 'supervisor' ? -1 : 1));

  return {
    generatedAt: new Date().toISOString(),
    periods,
    people: result,
  };
}
