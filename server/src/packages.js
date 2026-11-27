/**
 * Paqueteria: guias activas y su seguimiento.
 *
 * Este modulo es la excepcion del sistema. Todo lo demas se deriva de un
 * Excel y se puede volver a construir; esto se captura a mano y es el unico
 * dato que, si se pierde, no se recupera. De ahi tres decisiones:
 *
 *   - El borrado es logico (`deleted_at`), nunca fisico.
 *   - Cada cambio deja una fila en `pkg_events` con quien y cuando.
 *   - Lo que se puede calcular no se guarda: si un paquete va retrasado o
 *     cuantos dias faltan sale de la fecha, no de una bandera que al dia
 *     siguiente estaria mintiendo.
 *
 * La bitacora es ademas el enganche de la funcion de notificaciones: permite
 * preguntar "que cambio desde tal momento" sin comparar estados completos.
 */
import { config } from './config.js';
import { db } from './db.js';
import { currentHeadcountId, loadHeadcount } from './analytics/headcount.js';
import { ROLES, roleLabel } from './parser/headcount.js';

/* ------------------------------- catalogos ------------------------------- */

/** Estados por los que pasa una guia. Conjunto cerrado a proposito. */
export const ESTADOS = [
  { key: 'EN_TRANSITO', label: 'En transito', open: true },
  { key: 'EN_SUCURSAL', label: 'En sucursal, listo para recoger', open: true },
  { key: 'RETRASADO', label: 'Retrasado', open: true },
  { key: 'INCIDENCIA', label: 'Con incidencia', open: true },
  { key: 'ENTREGADO', label: 'Entregado', open: false },
  { key: 'CANCELADO', label: 'Cancelado', open: false },
];
const ESTADO_KEYS = new Set(ESTADOS.map((e) => e.key));
const ABIERTOS = ESTADOS.filter((e) => e.open).map((e) => e.key);
export const estadoLabel = (k) => ESTADOS.find((e) => e.key === k)?.label || k;

export const ENTREGAS = [
  { key: 'DOMICILIO', label: 'A domicilio' },
  { key: 'OCURRE', label: 'Ocurre (oficina de la paqueteria)' },
  { key: 'OFICINA', label: 'Oficina HONOR' },
];
const ENTREGA_KEYS = new Set(ENTREGAS.map((e) => e.key));
export const entregaLabel = (k) => ENTREGAS.find((e) => e.key === k)?.label || k;

/** Roles que pueden recibir un paquete: los mandos medios del sitio. */
const ROLES_MANDO = new Set(ROLES.filter((r) => r.group === 'mando').map((r) => r.key));

export function listCarriers({ all = false } = {}) {
  const sql = all
    ? 'SELECT * FROM pkg_carriers ORDER BY sort, name'
    : 'SELECT * FROM pkg_carriers WHERE active = 1 ORDER BY sort, name';
  return db.prepare(sql).all().map((c) => ({
    code: c.code,
    name: c.name,
    trackUrl: c.track_url,
    sort: c.sort,
    active: Boolean(c.active),
  }));
}

export function listOffices({ all = false } = {}) {
  const sql = all
    ? 'SELECT * FROM pkg_offices ORDER BY sort, name'
    : 'SELECT * FROM pkg_offices WHERE active = 1 ORDER BY sort, name';
  return db.prepare(sql).all().map((o) => ({
    code: o.code,
    name: o.name,
    city: o.city,
    state: o.state,
    address: o.address,
    sort: o.sort,
    active: Boolean(o.active),
  }));
}

/**
 * Posibles destinatarios: los mandos medios de la plantilla vigente mas las
 * oficinas de HONOR. Si todavia no hay plantilla cargada se devuelven solo
 * las oficinas, para que la seccion funcione desde el primer dia.
 */
export function listRecipients() {
  const oficinas = listOffices().map((o) => ({
    kind: 'OFICINA',
    key: o.code,
    name: o.name,
    role: 'Oficina',
    roleLabel: 'Oficina HONOR',
    region: null,
    city: o.city,
    state: o.state,
  }));

  const hcId = currentHeadcountId();
  const snap = hcId ? loadHeadcount(hcId) : null;
  const personas = !snap
    ? []
    : snap.people
        .filter((p) => ROLES_MANDO.has(p.role))
        .map((p) => ({
          kind: 'PERSONA',
          key: p.key,
          name: p.name,
          role: p.role,
          roleLabel: roleLabel(p.role),
          region: p.region,
          city: p.city,
          state: p.state,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { oficinas, personas };
}

/**
 * Ciudades conocidas, para autocompletar origen y destino.
 *
 * Se agrupan ignorando acentos: la plantilla trae "ASCENSION" y "ASCENSIÓN"
 * como si fueran dos ciudades distintas y en una lista de sugerencias eso
 * solo estorba. Se conserva la primera forma que aparece.
 */
const sinAcentos = (v) => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function listCities() {
  const hcId = currentHeadcountId();
  const snap = hcId ? loadHeadcount(hcId) : null;
  const vistas = new Map();
  const ver = (city, state) => {
    const k = sinAcentos(city);
    if (!vistas.has(k)) vistas.set(k, { city, state: state || null });
  };
  for (const s of snap?.stores || []) {
    if (s.city) ver(s.city, s.state);
  }
  for (const o of listOffices()) {
    if (o.city) ver(o.city, o.state);
  }
  // Las ciudades ya capturadas en paqueteria tambien cuentan: puede haber
  // origenes (una bodega, un proveedor) que no existen en la plantilla.
  for (const r of db
    .prepare(
      `SELECT origin_city AS city, origin_state AS state FROM pkg_packages WHERE origin_city IS NOT NULL
       UNION SELECT dest_city, dest_state FROM pkg_packages WHERE dest_city IS NOT NULL`
    )
    .all()) {
    if (r.city) ver(r.city, r.state);
  }
  return [...vistas.values()].sort((a, b) => a.city.localeCompare(b.city, 'es'));
}

/* -------------------------------- utiles --------------------------------- */

/** El dia de hoy en la zona horaria de la operacion, como YYYY-MM-DD. */
export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DIA_MS = 86400000;

/** Dias entre dos fechas ISO (positivo si `b` es posterior a `a`). */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / DIA_MS) : null;
}

const texto = (v, max = 400) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const parrafo = (v, max = 4000) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const mayus = (v, max = 120) => {
  const s = texto(v, max);
  return s ? s.toUpperCase() : null;
};

/** La guia se guarda tal cual se escribio, y normalizada para comparar. */
export const trackingKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
function fecha(v, campo) {
  const s = texto(v, 10);
  if (!s) return null;
  if (!FECHA.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new ValidationError(`La fecha de ${campo} no es valida.`);
  }
  return s;
}

export class ValidationError extends Error {
  constructor(message, code = 'INVALIDO') {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

/* ------------------------------- lectura --------------------------------- */

const carrierMap = () => new Map(listCarriers({ all: true }).map((c) => [c.code, c]));

/**
 * Agrega a la fila lo que se calcula y nunca se guarda: dias para la llegada,
 * si va retrasado y en que tramo de la agenda cae.
 */
function decorate(row, carriers, hoy) {
  const carrier = carriers.get(row.carrier_code);
  const abierto = ABIERTOS.includes(row.status);
  const dias = daysBetween(hoy, row.eta_date);
  const retrasado = Boolean(abierto && dias !== null && dias < 0);

  let tramo = 'sin_fecha';
  if (dias !== null) {
    if (dias < 0) tramo = 'retrasado';
    else if (dias === 0) tramo = 'hoy';
    else if (dias === 1) tramo = 'manana';
    else if (dias <= 7) tramo = 'semana';
    else tramo = 'despues';
  }

  return {
    id: row.id,
    tracking: row.tracking,
    carrier: row.carrier_code,
    carrierName: row.carrier_code === 'OTRA' && row.carrier_other
      ? row.carrier_other
      : carrier?.name || row.carrier_code,
    carrierOther: row.carrier_other,
    trackUrl: carrier?.trackUrl || null,
    deliveryMode: row.delivery_mode,
    deliveryLabel: entregaLabel(row.delivery_mode),
    recipientKind: row.recipient_kind,
    recipientKey: row.recipient_key,
    recipientName: row.recipient_name,
    recipientRole: row.recipient_role,
    recipientRegion: row.recipient_region,
    originCity: row.origin_city,
    originState: row.origin_state,
    destCity: row.dest_city,
    destState: row.dest_state,
    destPlace: row.dest_place,
    shippedDate: row.shipped_date,
    etaDate: row.eta_date,
    status: row.status,
    statusLabel: estadoLabel(row.status),
    open: abierto,
    contents: row.contents,
    notes: row.notes,
    deliveredAt: row.delivered_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    // calculado, no almacenado
    daysToEta: abierto ? dias : null,
    late: retrasado,
    bucket: abierto ? tramo : 'cerrado',
    transitDays: daysBetween(row.shipped_date, row.delivered_at || hoy),
  };
}

export function getPackage(id) {
  const row = db.prepare('SELECT * FROM pkg_packages WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  const pkg = decorate(row, carrierMap(), todayIso());
  pkg.events = db
    .prepare('SELECT at, actor, kind, detail FROM pkg_events WHERE package_id = ? ORDER BY at DESC, id DESC')
    .all(row.id);
  return pkg;
}

/**
 * Lista de guias. `scope` decide el corte principal: `abiertas` es el dia a
 * dia, `cerradas` el historial y `todas` el universo completo.
 */
export function listPackages(filtros = {}) {
  const where = ['deleted_at IS NULL'];
  const args = [];

  const huecos = ABIERTOS.map(() => '?').join(',');
  const scope = filtros.scope || 'abiertas';
  if (scope === 'abiertas') {
    where.push(`status IN (${huecos})`);
    args.push(...ABIERTOS);
  } else if (scope === 'cerradas') {
    where.push(`status NOT IN (${huecos})`);
    args.push(...ABIERTOS);
  }

  if (filtros.status && ESTADO_KEYS.has(filtros.status)) {
    where.push('status = ?');
    args.push(filtros.status);
  }
  if (filtros.carrier) {
    where.push('carrier_code = ?');
    args.push(filtros.carrier);
  }
  if (filtros.region) {
    where.push('recipient_region = ?');
    args.push(mayus(filtros.region));
  }
  if (filtros.recipient) {
    where.push('recipient_key = ?');
    args.push(filtros.recipient);
  }
  if (filtros.deliveryMode && ENTREGA_KEYS.has(filtros.deliveryMode)) {
    where.push('delivery_mode = ?');
    args.push(filtros.deliveryMode);
  }
  if (filtros.search) {
    const t = `%${trackingKey(filtros.search)}%`;
    const libre = `%${String(filtros.search).trim().toUpperCase()}%`;
    where.push('(tracking_key LIKE ? OR UPPER(recipient_name) LIKE ? OR UPPER(IFNULL(contents,\'\')) LIKE ?)');
    args.push(t, libre, libre);
  }

  const rows = db
    .prepare(
      `SELECT * FROM pkg_packages WHERE ${where.join(' AND ')}
       ORDER BY eta_date IS NULL, eta_date, created_at DESC`
    )
    .all(...args);

  const hoy = todayIso();
  const carriers = carrierMap();
  const items = rows.map((r) => decorate(r, carriers, hoy));

  // Los retrasados primero: son los que piden accion.
  if (scope !== 'cerradas') {
    items.sort((a, b) => Number(b.late) - Number(a.late));
  }
  return { today: hoy, items, summary: summarize(hoy) };
}

/** Los cuatro indicadores de la cabecera. Siempre sobre el universo completo. */
export function summarize(hoy = todayIso()) {
  const abiertas = db
    .prepare(
      `SELECT status, eta_date FROM pkg_packages
       WHERE deleted_at IS NULL AND status IN (${ABIERTOS.map(() => '?').join(',')})`
    )
    .all(...ABIERTOS);

  let enTransito = 0;
  let semana = 0;
  let retrasados = 0;
  for (const r of abiertas) {
    enTransito += 1;
    const d = daysBetween(hoy, r.eta_date);
    if (d === null) continue;
    if (d < 0) retrasados += 1;
    else if (d <= 7) semana += 1;
  }

  const mes = hoy.slice(0, 7);
  const entregados = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pkg_packages
       WHERE deleted_at IS NULL AND status = 'ENTREGADO' AND substr(IFNULL(delivered_at, updated_at),1,7) = ?`
    )
    .get(mes).n;

  return { activos: enTransito, semana, retrasados, entregadosMes: entregados, mes };
}

/** Agenda de llegadas: las guias abiertas agrupadas por cercania. */
export function buildAgenda(filtros = {}) {
  const { today, items, summary } = listPackages({ ...filtros, scope: 'abiertas' });
  const orden = ['retrasado', 'hoy', 'manana', 'semana', 'despues', 'sin_fecha'];
  const titulos = {
    retrasado: 'Retrasados',
    hoy: 'Llegan hoy',
    manana: 'Llegan manana',
    semana: 'Esta semana',
    despues: 'Mas adelante',
    sin_fecha: 'Sin fecha estimada',
  };
  const grupos = orden
    .map((key) => ({ key, label: titulos[key], items: items.filter((i) => i.bucket === key) }))
    .filter((g) => g.items.length);
  return { today, summary, groups: grupos };
}

/* ------------------------------- escritura -------------------------------- */

function logEvent(packageId, actor, kind, detail) {
  db.prepare('INSERT INTO pkg_events (package_id, at, actor, kind, detail) VALUES (?,?,?,?,?)').run(
    packageId,
    new Date().toISOString(),
    actor || null,
    kind,
    detail || null
  );
}

/**
 * Valida y normaliza lo que llega del formulario. El destinatario se resuelve
 * contra el catalogo y se copia su nombre, rol y region: si manana esa persona
 * sale de la plantilla, el paquete sigue diciendo a quien iba.
 */
function normalize(body, { parcial = false, actual = null } = {}) {
  const v = (campo, fallback) => (body[campo] === undefined && parcial ? fallback : body[campo]);

  const tracking = texto(v('tracking', actual?.tracking), 60);
  if (!tracking) throw new ValidationError('Falta el numero de guia.');

  const carrier = texto(v('carrier', actual?.carrier_code), 40)?.toUpperCase() || null;
  if (!carrier) throw new ValidationError('Falta la paqueteria.');
  const conocida = db.prepare('SELECT code FROM pkg_carriers WHERE code = ?').get(carrier);
  if (!conocida) throw new ValidationError('Esa paqueteria no esta en el catalogo.');
  const carrierOther = carrier === 'OTRA' ? texto(v('carrierOther', actual?.carrier_other), 80) : null;
  if (carrier === 'OTRA' && !carrierOther) {
    throw new ValidationError('Escribe el nombre de la paqueteria.');
  }

  const deliveryMode = texto(v('deliveryMode', actual?.delivery_mode), 20)?.toUpperCase() || null;
  if (!ENTREGA_KEYS.has(deliveryMode)) throw new ValidationError('Indica como se entrega el paquete.');

  const kind = texto(v('recipientKind', actual?.recipient_kind), 20)?.toUpperCase() || 'PERSONA';
  const key = texto(v('recipientKey', actual?.recipient_key), 120);
  if (!key) throw new ValidationError('Falta quien recibe el paquete.');

  const { personas, oficinas } = listRecipients();
  const elegido = (kind === 'OFICINA' ? oficinas : personas).find((r) => r.key === key);
  let recipient;
  if (elegido) {
    recipient = {
      kind,
      key,
      name: elegido.name,
      role: elegido.roleLabel,
      region: elegido.region,
    };
  } else if (actual && actual.recipient_key === key) {
    // El destinatario ya no esta en la plantilla vigente (salio de la empresa
    // o cambio la carga). Se conserva lo que se guardo al dar de alta.
    recipient = {
      kind: actual.recipient_kind,
      key: actual.recipient_key,
      name: actual.recipient_name,
      role: actual.recipient_role,
      region: actual.recipient_region,
    };
  } else {
    throw new ValidationError('Ese destinatario no existe en la plantilla ni en las oficinas.');
  }

  const status = texto(v('status', actual?.status), 20)?.toUpperCase() || 'EN_TRANSITO';
  if (!ESTADO_KEYS.has(status)) throw new ValidationError('Ese estado no existe.');

  const etaDate = fecha(v('etaDate', actual?.eta_date), 'llegada estimada');
  const shippedDate = fecha(v('shippedDate', actual?.shipped_date), 'envio');
  if (etaDate && shippedDate && etaDate < shippedDate) {
    throw new ValidationError('La fecha de llegada no puede ser anterior a la de envio.');
  }

  return {
    tracking,
    tracking_key: trackingKey(tracking),
    carrier_code: carrier,
    carrier_other: carrierOther,
    delivery_mode: deliveryMode,
    recipient_kind: recipient.kind,
    recipient_key: recipient.key,
    recipient_name: recipient.name,
    recipient_role: recipient.role,
    recipient_region: recipient.region,
    origin_city: mayus(v('originCity', actual?.origin_city)),
    origin_state: mayus(v('originState', actual?.origin_state)),
    dest_city: mayus(v('destCity', actual?.dest_city)),
    dest_state: mayus(v('destState', actual?.dest_state)),
    dest_place: texto(v('destPlace', actual?.dest_place), 200),
    shipped_date: shippedDate,
    eta_date: etaDate,
    status,
    contents: parrafo(v('contents', actual?.contents)),
    notes: parrafo(v('notes', actual?.notes)),
  };
}

/** Busca una guia igual ya capturada (misma paqueteria y mismo numero). */
export function findDuplicate(carrier, tracking, exceptId = null) {
  return db
    .prepare(
      `SELECT id, tracking, recipient_name, status, created_at FROM pkg_packages
       WHERE deleted_at IS NULL AND carrier_code = ? AND tracking_key = ? AND id IS NOT ?`
    )
    .get(carrier, trackingKey(tracking), exceptId);
}

export function createPackage(body, actor) {
  const datos = normalize(body);

  if (!body.force) {
    const dup = findDuplicate(datos.carrier_code, datos.tracking);
    if (dup) {
      const err = new ValidationError(
        `Esa guia ya esta capturada para ${dup.recipient_name}. Si de verdad es otro paquete, vuelve a guardar para confirmar.`,
        'DUPLICADO'
      );
      err.status = 409;
      err.duplicate = dup;
      throw err;
    }
  }

  const ahora = new Date().toISOString();
  const campos = { ...datos, created_by: actor || null, created_at: ahora, updated_by: actor || null, updated_at: ahora };
  if (datos.status === 'ENTREGADO') campos.delivered_at = todayIso();

  const cols = Object.keys(campos);
  const info = db
    .prepare(`INSERT INTO pkg_packages (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`)
    .run(campos);

  logEvent(info.lastInsertRowid, actor, 'alta', `Guia ${datos.tracking} para ${datos.recipient_name}`);
  return getPackage(info.lastInsertRowid);
}

/** Etiquetas legibles para la bitacora: el log tiene que leerse sin el codigo. */
const ETIQUETAS = {
  tracking: 'guia',
  carrier_code: 'paqueteria',
  carrier_other: 'nombre de la paqueteria',
  delivery_mode: 'forma de entrega',
  recipient_key: 'destinatario',
  origin_city: 'ciudad de origen',
  origin_state: 'estado de origen',
  dest_city: 'ciudad de destino',
  dest_state: 'estado de destino',
  dest_place: 'lugar de entrega',
  shipped_date: 'fecha de envio',
  eta_date: 'llegada estimada',
  status: 'estado',
  contents: 'contenido',
  notes: 'notas',
};

export function updatePackage(id, body, actor) {
  const actual = db.prepare('SELECT * FROM pkg_packages WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!actual) return null;

  const datos = normalize(body, { parcial: true, actual });

  const cambios = [];
  for (const [campo, etiqueta] of Object.entries(ETIQUETAS)) {
    const antes = actual[campo] ?? null;
    const ahora = datos[campo] ?? null;
    if (antes === ahora) continue;
    if (campo === 'contents' || campo === 'notes') cambios.push(`cambio ${etiqueta}`);
    else if (campo === 'status') cambios.push(`estado: ${estadoLabel(antes)} -> ${estadoLabel(ahora)}`);
    else cambios.push(`${etiqueta}: ${antes || '(vacio)'} -> ${ahora || '(vacio)'}`);
  }
  if (!cambios.length) return getPackage(id);

  const campos = { ...datos, id: actual.id, updated_by: actor || null, updated_at: new Date().toISOString() };
  // La fecha de entrega sigue al estado: se pone al entregar y se limpia si
  // el paquete vuelve a abrirse porque se registro por error.
  campos.delivered_at =
    datos.status === 'ENTREGADO' ? actual.delivered_at || todayIso() : datos.status === 'CANCELADO' ? actual.delivered_at : null;

  db.prepare(
    `UPDATE pkg_packages SET
       tracking=@tracking, tracking_key=@tracking_key, carrier_code=@carrier_code, carrier_other=@carrier_other,
       delivery_mode=@delivery_mode, recipient_kind=@recipient_kind, recipient_key=@recipient_key,
       recipient_name=@recipient_name, recipient_role=@recipient_role, recipient_region=@recipient_region,
       origin_city=@origin_city, origin_state=@origin_state, dest_city=@dest_city, dest_state=@dest_state,
       dest_place=@dest_place, shipped_date=@shipped_date, eta_date=@eta_date, status=@status,
       contents=@contents, notes=@notes, delivered_at=@delivered_at, updated_by=@updated_by, updated_at=@updated_at
     WHERE id=@id`
  ).run(campos);

  const soloEstado = cambios.length === 1 && cambios[0].startsWith('estado:');
  logEvent(actual.id, actor, soloEstado ? 'estado' : 'datos', cambios.join(' · '));
  return getPackage(actual.id);
}

/** Cambio rapido de estado desde la tabla, sin abrir el formulario. */
export function setStatus(id, status, actor, note) {
  if (!ESTADO_KEYS.has(status)) throw new ValidationError('Ese estado no existe.');
  const actual = db.prepare('SELECT * FROM pkg_packages WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!actual) return null;
  if (actual.status === status && !note) return getPackage(id);

  const delivered = status === 'ENTREGADO' ? actual.delivered_at || todayIso() : null;
  db.prepare(
    'UPDATE pkg_packages SET status=?, delivered_at=?, updated_by=?, updated_at=? WHERE id=?'
  ).run(status, delivered, actor || null, new Date().toISOString(), actual.id);

  const detalle = `estado: ${estadoLabel(actual.status)} -> ${estadoLabel(status)}`;
  logEvent(actual.id, actor, 'estado', note ? `${detalle} · ${parrafo(note, 300)}` : detalle);
  return getPackage(actual.id);
}

/**
 * Borrado logico. Nada se pierde: la fila queda fuera de las consultas pero
 * conserva su bitacora, que es lo que permite explicar despues que paso.
 */
export function removePackage(id, actor) {
  const actual = db.prepare('SELECT * FROM pkg_packages WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!actual) return null;
  db.prepare('UPDATE pkg_packages SET deleted_at=?, updated_by=?, updated_at=? WHERE id=?').run(
    new Date().toISOString(),
    actor || null,
    new Date().toISOString(),
    actual.id
  );
  logEvent(actual.id, actor, 'baja', `Guia ${actual.tracking} dada de baja`);
  return { id: actual.id, tracking: actual.tracking };
}

/** Filas para el CSV, con los mismos encabezados que muestra la tabla. */
export function packagesCsv(filtros = {}) {
  const { items } = listPackages({ ...filtros, scope: filtros.scope || 'todas' });
  return items.map((p) => ({
    Guia: p.tracking,
    Paqueteria: p.carrierName,
    Destinatario: p.recipientName,
    Rol: p.recipientRole || '',
    Region: p.recipientRegion || '',
    Entrega: p.deliveryLabel,
    Lugar: p.destPlace || '',
    Origen: [p.originCity, p.originState].filter(Boolean).join(', '),
    Destino: [p.destCity, p.destState].filter(Boolean).join(', '),
    Envio: p.shippedDate || '',
    'Llegada estimada': p.etaDate || '',
    Estado: p.statusLabel,
    'Dias para llegar': p.daysToEta ?? '',
    Retrasado: p.late ? 'si' : 'no',
    Entregado: p.deliveredAt || '',
    Contenido: p.contents || '',
    Notas: p.notes || '',
  }));
}
