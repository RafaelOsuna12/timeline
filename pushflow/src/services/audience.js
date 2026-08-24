/**
 * Motor de audiencia y segmentos.
 *
 * Traduce filtros con la misma sintaxis que OneSignal a SQL sobre `subscriptions`:
 *
 *   [{"field":"tag","key":"plan","relation":"=","value":"pro"},
 *    {"operator":"OR"},
 *    {"field":"country","relation":"=","value":"MX"},
 *    {"field":"last_session","relation":">","hours_ago":"24"},
 *    {"field":"location","lat":19.43,"long":-99.13,"radius":5000}]
 *
 * Los filtros consecutivos se combinan con AND; `{"operator":"OR"}` abre un
 * nuevo grupo. El resultado es: (grupo1) OR (grupo2) OR ...
 */
import { Params, many, one, scalar } from '../db/index.js';
import { badRequest } from '../lib/errors.js';

const NUMERIC_RELATIONS = new Set(['>', '<', '>=', '<=']);
const ALL_RELATIONS = new Set(['>', '<', '>=', '<=', '=', '!=', 'exists', 'not_exists']);

/** Campos simples: nombre del filtro -> columna + casteo. */
const COLUMN_FIELDS = {
  country:          { col: 'country', type: 'text', upper: true },
  language:         { col: 'language', type: 'text', lower: true },
  city:             { col: 'city', type: 'text' },
  region:           { col: 'region', type: 'text' },
  timezone:         { col: 'timezone', type: 'text' },
  app_version:      { col: 'app_version', type: 'text' },
  sdk_version:      { col: 'sdk_version', type: 'text' },
  device_model:     { col: 'device_model', type: 'text' },
  device_os:        { col: 'device_os', type: 'text' },
  browser_name:     { col: 'browser_name', type: 'text' },
  device_type:      { col: 'device_type', type: 'text' },
  channel:          { col: 'channel', type: 'text' },
  external_user_id: { col: 'external_user_id', type: 'text' },
  session_count:    { col: 'session_count', type: 'numeric' },
  session_time:     { col: 'total_duration_sec', type: 'numeric' },
  test_type:        { col: 'test_type', type: 'numeric' },
};

/** Campos de fecha que se comparan con "hace N horas". */
const TIME_FIELDS = {
  last_session:      'last_seen_at',
  first_session:     'first_seen_at',
  last_notification: 'last_notification_at',
  created_at:        'created_at',
};

function fieldOf(filter) {
  return String(filter.field || '').toLowerCase();
}

function relationOf(filter) {
  const rel = String(filter.relation ?? '=').trim();
  if (!ALL_RELATIONS.has(rel)) throw badRequest(`Relación de filtro no soportada: ${rel}`);
  return rel;
}

/** Construye la condición SQL de un único filtro. */
function filterToSql(filter, p) {
  const field = fieldOf(filter);
  const rel = relationOf(filter);

  // --- Tags (jsonb) ---------------------------------------------------------
  if (field === 'tag') {
    const key = filter.key;
    if (!key) throw badRequest('Un filtro `tag` requiere `key`');
    const keyParam = p.add(String(key));
    if (rel === 'exists') return `(s.tags ? ${keyParam})`;
    if (rel === 'not_exists') return `(NOT (s.tags ? ${keyParam}))`;

    const raw = filter.value;
    if (raw === undefined || raw === null) throw badRequest(`El filtro tag \`${key}\` requiere \`value\``);

    // Comparación numérica cuando ambos lados son numéricos, textual en otro caso.
    if (NUMERIC_RELATIONS.has(rel) || (rel !== '=' && rel !== '!=' && !Number.isNaN(Number(raw)))) {
      const num = Number(raw);
      if (Number.isNaN(num)) throw badRequest(`El filtro tag \`${key}\` con relación ${rel} requiere un número`);
      const valParam = p.add(num);
      return `((s.tags->>${keyParam}) ~ '^-?[0-9]+(\\.[0-9]+)?$'
               AND (s.tags->>${keyParam})::numeric ${rel} ${valParam})`;
    }
    const valParam = p.add(String(raw));
    return rel === '!='
      ? `(s.tags->>${keyParam} IS DISTINCT FROM ${valParam})`
      : `(s.tags->>${keyParam} = ${valParam})`;
  }

  // --- Campos temporales ("hours_ago") --------------------------------------
  if (TIME_FIELDS[field]) {
    const col = TIME_FIELDS[field];
    if (filter.hours_ago !== undefined) {
      const hours = Number(filter.hours_ago);
      if (Number.isNaN(hours)) throw badRequest(`\`hours_ago\` inválido en el filtro ${field}`);
      const param = p.add(hours);
      // relation ">" = "hace más de N horas"  →  la marca temporal es más antigua
      const op = rel === '>' ? '<' : rel === '<' ? '>' : rel;
      return `(s.${col} ${op} now() - (${param} || ' hours')::interval)`;
    }
    if (filter.value !== undefined) {
      const param = p.add(new Date(filter.value));
      return `(s.${col} ${rel === '!=' ? '<>' : rel} ${param})`;
    }
    if (rel === 'exists') return `(s.${col} IS NOT NULL)`;
    if (rel === 'not_exists') return `(s.${col} IS NULL)`;
    throw badRequest(`El filtro ${field} requiere \`hours_ago\` o \`value\``);
  }

  // --- Radio geográfico -----------------------------------------------------
  if (field === 'location') {
    const lat = Number(filter.lat), lng = Number(filter.long ?? filter.lng);
    const radius = Number(filter.radius ?? 1000); // metros
    if ([lat, lng, radius].some(Number.isNaN)) {
      throw badRequest('El filtro `location` requiere lat, long y radius numéricos');
    }
    const latP = p.add(lat), lngP = p.add(lng), radP = p.add(radius);
    // Haversine en SQL puro (evita depender de PostGIS).
    return `(s.lat IS NOT NULL AND s.lng IS NOT NULL AND
      6371000 * 2 * asin(sqrt(
        power(sin(radians(s.lat - ${latP}) / 2), 2) +
        cos(radians(${latP})) * cos(radians(s.lat)) *
        power(sin(radians(s.lng - ${lngP}) / 2), 2)
      )) <= ${radP})`;
  }

  // --- Compras / gasto acumulado (guardados como tags reservados) -----------
  if (field === 'amount_spent' || field === 'bought_sku') {
    const key = p.add(field === 'amount_spent' ? '_amount_spent' : `_sku_${filter.key || filter.sku}`);
    if (field === 'bought_sku' && rel === 'exists') return `(s.tags ? ${key})`;
    const num = Number(filter.value);
    if (Number.isNaN(num)) throw badRequest(`El filtro ${field} requiere un \`value\` numérico`);
    const valParam = p.add(num);
    return `((s.tags->>${key}) ~ '^-?[0-9]+(\\.[0-9]+)?$'
             AND (s.tags->>${key})::numeric ${NUMERIC_RELATIONS.has(rel) ? rel : '='} ${valParam})`;
  }

  // --- Campos de columna directa -------------------------------------------
  const spec = COLUMN_FIELDS[field];
  if (!spec) throw badRequest(`Campo de filtro desconocido: ${field}`);

  if (rel === 'exists') return `(s.${spec.col} IS NOT NULL)`;
  if (rel === 'not_exists') return `(s.${spec.col} IS NULL)`;

  if (spec.type === 'numeric') {
    const num = Number(filter.value);
    if (Number.isNaN(num)) throw badRequest(`El filtro ${field} requiere un \`value\` numérico`);
    const param = p.add(num);
    return `(s.${spec.col} ${rel === '!=' ? '<>' : rel} ${param})`;
  }

  // Listas: {"field":"country","relation":"=","value":["MX","ES"]}
  if (Array.isArray(filter.value)) {
    let values = filter.value.map(String);
    if (spec.upper) values = values.map((v) => v.toUpperCase());
    if (spec.lower) values = values.map((v) => v.toLowerCase());
    const param = p.add(values);
    return rel === '!=' ? `(NOT (s.${spec.col} = ANY(${param})))` : `(s.${spec.col} = ANY(${param}))`;
  }

  let value = String(filter.value ?? '');
  if (spec.upper) value = value.toUpperCase();
  if (spec.lower) value = value.toLowerCase();
  const param = p.add(value);
  if (rel === '!=') return `(s.${spec.col} IS DISTINCT FROM ${param})`;
  if (rel === '=') return `(s.${spec.col} = ${param})`;
  return `(s.${spec.col} ${rel} ${param})`;   // comparación lexicográfica (ej. app_version)
}

/**
 * Convierte una lista de filtros (con separadores {"operator":"OR"}) en SQL.
 * Devuelve `null` si la lista está vacía.
 */
export function buildFilterSql(filters, p) {
  if (!Array.isArray(filters) || filters.length === 0) return null;
  const orGroups = [];
  let current = [];
  for (const filter of filters) {
    if (filter && filter.operator && !filter.field) {
      const op = String(filter.operator).toUpperCase();
      if (op === 'OR') { orGroups.push(current); current = []; continue; }
      if (op === 'AND') continue;
      throw badRequest(`Operador no soportado: ${filter.operator}`);
    }
    current.push(filterToSql(filter, p));
  }
  orGroups.push(current);

  const groups = orGroups.filter((g) => g.length > 0).map((g) => `(${g.join(' AND ')})`);
  if (groups.length === 0) return null;
  return groups.length === 1 ? groups[0] : `(${groups.join(' OR ')})`;
}

/** Base común: solo suscripciones vivas de la app. */
function baseConditions(appId, channels, p) {
  const conds = [
    `s.app_id = ${p.add(appId)}`,
    's.subscribed = true',
    's.invalid = false',
    's.opted_out = false',
  ];
  if (Array.isArray(channels) && channels.length) {
    conds.push(`s.channel = ANY(${p.add(channels)})`);
  }
  return conds;
}

/**
 * Construye la consulta de audiencia para una notificación.
 * `target` = { targetType, includedSegments, excludedSegments, filters,
 *              includeSubscriptionIds, includeExternalIds, channels }
 */
export async function buildAudienceQuery(appId, target, { columns = 's.*' } = {}) {
  const p = new Params();
  const conds = baseConditions(appId, target.channels, p);

  switch (target.targetType) {
    case 'subscription_ids': {
      if (!target.includeSubscriptionIds?.length) throw badRequest('`include_subscription_ids` está vacío');
      conds.push(`s.id = ANY(${p.add(target.includeSubscriptionIds)})`);
      break;
    }
    case 'external_ids': {
      if (!target.includeExternalIds?.length) throw badRequest('`include_external_ids` está vacío');
      conds.push(`s.external_user_id = ANY(${p.add(target.includeExternalIds)})`);
      break;
    }
    case 'filters': {
      const sql = buildFilterSql(target.filters, p);
      if (sql) conds.push(sql);
      break;
    }
    case 'all':
      break;
    case 'segments':
    default: {
      const segmentIds = target.includedSegments || [];
      if (segmentIds.length) {
        const segments = await many(
          'SELECT id, name, filters FROM segments WHERE app_id = $1 AND id = ANY($2)',
          [appId, segmentIds]);
        if (segments.length !== segmentIds.length) throw badRequest('Uno o más segmentos no existen');
        const parts = [];
        for (const seg of segments) {
          const sql = buildFilterSql(seg.filters, p);
          if (sql) parts.push(sql);
        }
        if (parts.length) conds.push(`(${parts.join(' OR ')})`);   // unión de segmentos incluidos
      }
      break;
    }
  }

  // Muestreo determinista para tests A/B: la misma suscripción cae siempre en
  // el mismo lado, así que la parte no muestreada es exactamente el resto.
  if (target.samplePercent != null && target.samplePercent < 100) {
    conds.push(`(abs(hashtext(s.id::text)) % 100) < ${p.add(Number(target.samplePercent))}`);
  }

  // Excluye a quien ya recibió otra notificación (envío de la variante ganadora).
  if (target.excludeDeliveredFor) {
    conds.push(`NOT EXISTS (
      SELECT 1 FROM deliveries d
      WHERE d.notification_id = ${p.add(target.excludeDeliveredFor)}
        AND d.subscription_id = s.id AND d.status <> 'skipped')`);
  }

  // Segmentos excluidos (se restan siempre, sea cual sea el modo de targeting).
  if (target.excludedSegments?.length) {
    const segments = await many(
      'SELECT id, filters FROM segments WHERE app_id = $1 AND id = ANY($2)',
      [appId, target.excludedSegments]);
    for (const seg of segments) {
      const sql = buildFilterSql(seg.filters, p);
      if (sql) conds.push(`NOT ${sql}`);
    }
  }

  return {
    sql: `SELECT ${columns} FROM subscriptions s WHERE ${conds.join(' AND ')}`,
    values: p.values,
    params: p,
  };
}

/** Número de destinatarios que alcanzaría una notificación. */
export async function countAudience(appId, target) {
  const q = await buildAudienceQuery(appId, target, { columns: 'count(*) AS n' });
  return Number(await scalar(q.sql, q.values)) || 0;
}

/** Cuenta los miembros de un segmento guardado. */
export async function countSegment(appId, segmentId) {
  const seg = await one('SELECT id, filters FROM segments WHERE app_id = $1 AND id = $2',
    [appId, segmentId]);
  if (!seg) throw badRequest('Segmento no encontrado');
  const p = new Params();
  const conds = baseConditions(appId, null, p);
  const sql = buildFilterSql(seg.filters, p);
  if (sql) conds.push(sql);
  return Number(await scalar(
    `SELECT count(*) FROM subscriptions s WHERE ${conds.join(' AND ')}`, p.values)) || 0;
}

/** ¿Una suscripción concreta cumple estos filtros? (usado por automatizaciones) */
export async function subscriptionMatches(appId, subscriptionId, filters) {
  const p = new Params();
  const conds = [`s.app_id = ${p.add(appId)}`, `s.id = ${p.add(subscriptionId)}`];
  const sql = buildFilterSql(filters, p);
  if (sql) conds.push(sql);
  const row = await one(`SELECT 1 AS ok FROM subscriptions s WHERE ${conds.join(' AND ')}`, p.values);
  return Boolean(row);
}

/**
 * Recorre la audiencia por lotes con paginación por keyset (id > last),
 * estable y sin OFFSET aunque la tabla cambie durante el envío.
 */
export async function* iterateAudience(appId, target, batchSize = 1000) {
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const q = await buildAudienceQuery(appId, target, {
      columns: 's.id, s.channel, s.endpoint, s.p256dh, s.auth_key, s.fcm_token, s.user_id, ' +
               's.language, s.timezone_offset, s.external_user_id, s.country',
    });
    const values = [...q.values, lastId, batchSize];
    const sql = `${q.sql} AND s.id > $${values.length - 1} ORDER BY s.id ASC LIMIT $${values.length}`;
    const rows = await many(sql, values);
    if (rows.length === 0) return;
    yield rows;
    lastId = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

export default {
  buildFilterSql, buildAudienceQuery, countAudience, countSegment,
  subscriptionMatches, iterateAudience,
};
