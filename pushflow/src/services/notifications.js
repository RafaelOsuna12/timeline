/**
 * Creación, programación y cancelación de notificaciones.
 *
 * Acepta el mismo cuerpo que la API de OneSignal (`headings`, `contents`,
 * `included_segments`, `filters`, `send_after`, `buttons`, `big_picture`, ...)
 * además de alias en español, y lo normaliza al modelo interno.
 */
import { one, many, query } from '../db/index.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import {
  localized, optionalUrl, parseWhen, uuidArray, clampInt, parseBool,
} from '../lib/validate.js';
import { countAudience } from './audience.js';
import { enqueue, cancelByUniqueKey } from './queue.js';
import logger from '../lib/logger.js';

const CHANNELS = new Set(['web_push', 'android']);

/** Normaliza los botones de acción (máximo 3 en la mayoría de plataformas). */
function parseButtons(input) {
  const raw = input.buttons || input.web_buttons || input.botones;
  if (!raw) return [];
  if (!Array.isArray(raw)) throw badRequest('`buttons` debe ser un array');
  return raw.slice(0, 3).map((btn, index) => {
    if (typeof btn === 'string') return { id: `btn${index}`, text: btn };
    if (!btn.text && !btn.title) throw badRequest(`El botón ${index} necesita \`text\``);
    return {
      id: String(btn.id || `btn${index}`).slice(0, 64),
      text: btn.text || btn.title,
      icon: btn.icon || null,
      url: optionalUrl(btn.url, `buttons[${index}].url`),
    };
  });
}

/** Valida y normaliza la configuración de test A/B. */
function parseAbTest(input) {
  const raw = input.ab_test || input.variants;
  if (!raw) return null;
  const variants = Array.isArray(raw) ? raw : raw.variants;
  if (!Array.isArray(variants) || variants.length < 2) {
    throw badRequest('Un test A/B necesita al menos 2 variantes');
  }
  return {
    variants: variants.map((v, index) => ({
      id: String(v.id || String.fromCharCode(65 + index)),
      weight: Number(v.weight ?? Math.floor(100 / variants.length)),
      headings: localized(v.headings ?? v.title, `ab_test.variants[${index}].headings`),
      contents: localized(v.contents ?? v.message, `ab_test.variants[${index}].contents`),
      ...(v.url ? { url: v.url } : {}),
      ...(v.image_url || v.big_picture ? { image_url: v.image_url || v.big_picture } : {}),
    })),
    winner: raw.winner || null,
    metric: raw.metric || 'ctr',
  };
}

/** Determina el modo de segmentación a partir del cuerpo recibido. */
function resolveTarget(input) {
  const includeSubscriptionIds = uuidArray(
    input.include_subscription_ids || input.include_player_ids, 'include_subscription_ids');
  const includeExternalIds = (input.include_external_user_ids || input.include_aliases?.external_id || [])
    .map(String);
  const includedSegments = uuidArray(input.included_segments || input.include_segments, 'included_segments');
  const excludedSegments = uuidArray(input.excluded_segments, 'excluded_segments');
  const filters = input.filters || [];

  if (includeSubscriptionIds.length) {
    return { targetType: 'subscription_ids', includeSubscriptionIds, excludedSegments,
             includedSegments: [], includeExternalIds: [], filters: [] };
  }
  if (includeExternalIds.length) {
    return { targetType: 'external_ids', includeExternalIds, excludedSegments,
             includedSegments: [], includeSubscriptionIds: [], filters: [] };
  }
  if (Array.isArray(filters) && filters.length) {
    return { targetType: 'filters', filters, excludedSegments,
             includedSegments: [], includeSubscriptionIds: [], includeExternalIds: [] };
  }
  if (includedSegments.length) {
    return { targetType: 'segments', includedSegments, excludedSegments,
             filters: [], includeSubscriptionIds: [], includeExternalIds: [] };
  }
  if (parseBool(input.include_all) || input.included_segments === 'all') {
    return { targetType: 'all', includedSegments: [], excludedSegments,
             filters: [], includeSubscriptionIds: [], includeExternalIds: [] };
  }
  throw badRequest(
    'Falta la segmentación: usa `included_segments`, `filters`, ' +
    '`include_subscription_ids`, `include_external_user_ids` o `include_all: true`');
}

/** Convierte el cuerpo de la petición en una fila de `notifications`. */
export async function buildNotification(app, input, { createdBy = null, source = 'api' } = {}) {
  let base = input;

  // Plantilla como base: los campos del cuerpo tienen prioridad.
  if (input.template_id) {
    const template = await one('SELECT * FROM templates WHERE app_id = $1 AND id = $2',
      [app.id, input.template_id]);
    if (!template) throw notFound('Plantilla no encontrada');
    base = { ...template.payload, ...input };
  }

  const headings = localized(base.headings ?? base.title ?? base.titulo, 'headings');
  const contents = localized(base.contents ?? base.message ?? base.mensaje ?? base.descripcion, 'contents');
  if (Object.keys(contents).length === 0 && !base.silent) {
    throw badRequest('`contents` (mensaje) es obligatorio');
  }

  const channels = (base.channels || ['web_push', 'android'])
    .map((c) => String(c).toLowerCase())
    .map((c) => (c === 'web' ? 'web_push' : c === 'apk' ? 'android' : c));
  for (const channel of channels) {
    if (!CHANNELS.has(channel)) throw badRequest(`Canal no soportado: ${channel}`);
  }

  const target = resolveTarget(base);
  const sendAfter = parseWhen(base.send_after || base.enviar_despues);
  const delayedOption = base.delayed_option
    || (base.delivery_time_of_day ? 'timezone' : null)
    || 'immediate';
  if (!['immediate', 'timezone', 'last-active'].includes(delayedOption)) {
    throw badRequest('`delayed_option` debe ser immediate, timezone o last-active');
  }

  return {
    app_id: app.id,
    template_id: base.template_id || null,
    name: base.name || null,
    headings,
    contents,
    subtitle: localized(base.subtitle, 'subtitle'),
    url: optionalUrl(base.url || base.enlace, 'url'),
    web_url: optionalUrl(base.web_url, 'web_url'),
    app_url: base.app_url || base.deep_link || null,     // admite esquemas propios (miapp://)
    launch_activity: base.launch_activity || null,
    icon_url: optionalUrl(base.icon_url || base.chrome_web_icon || app.default_icon_url, 'icon_url'),
    image_url: optionalUrl(base.image_url || base.big_picture || base.chrome_web_image || base.imagen, 'image_url'),
    badge_url: optionalUrl(base.badge_url || base.chrome_web_badge, 'badge_url'),
    large_icon: optionalUrl(base.large_icon, 'large_icon'),
    buttons: parseButtons(base),
    android_channel_id: base.android_channel_id || null,
    android_sound: base.android_sound || null,
    android_accent_color: base.android_accent_color || null,
    android_group: base.android_group || null,
    android_visibility: base.android_visibility != null ? Number(base.android_visibility) : null,
    web_push_topic: base.web_push_topic || null,
    priority: clampInt(base.priority, { min: 1, max: 10, def: 10 }),
    ttl: clampInt(base.ttl, { min: 0, max: 2419200, def: 259200 }),
    collapse_id: base.collapse_id || null,
    require_interaction: parseBool(base.require_interaction ?? base.chrome_web_require_interaction),
    silent: parseBool(base.silent ?? base.content_available),
    vibration_pattern: Array.isArray(base.vibration_pattern)
      ? base.vibration_pattern.map(Number).slice(0, 10) : null,
    data: base.data || base.additional_data || {},
    target_type: target.targetType,
    included_segments: target.includedSegments,
    excluded_segments: target.excludedSegments,
    filters: target.filters,
    include_subscription_ids: target.includeSubscriptionIds,
    include_external_ids: target.includeExternalIds,
    channels,
    send_after: sendAfter,
    delayed_option: delayedOption,
    delivery_time_of_day: base.delivery_time_of_day || null,
    throttle_per_minute: base.throttle_rate_per_minute
      ? Number(base.throttle_rate_per_minute) : null,
    respect_quiet_hours: parseBool(base.respect_quiet_hours, true),
    respect_frequency_cap: parseBool(base.respect_frequency_cap, true),
    ab_test: parseAbTest(base),
    idempotency_key: base.idempotency_key || base.external_id || null,
    created_by: createdBy,
    source,
  };
}

/** Crea la notificación y la encola (o la deja programada). */
export async function createNotification(app, input, options = {}) {
  const row = await buildNotification(app, input, options);
  const dryRun = parseBool(input.dry_run);

  // Estimación previa sin crear nada.
  if (dryRun) {
    const recipients = await countAudience(app.id, {
      targetType: row.target_type,
      includedSegments: row.included_segments,
      excludedSegments: row.excluded_segments,
      filters: row.filters,
      includeSubscriptionIds: row.include_subscription_ids,
      includeExternalIds: row.include_external_ids,
      channels: row.channels,
    });
    return { dry_run: true, estimated_recipients: recipients, notification: row };
  }

  if (row.idempotency_key) {
    const existing = await one(
      'SELECT * FROM notifications WHERE app_id = $1 AND idempotency_key = $2',
      [app.id, row.idempotency_key]);
    if (existing) return { notification: existing, deduplicated: true };
  }

  const scheduled = row.send_after && row.send_after.getTime() > Date.now() + 5000;
  const status = input.draft ? 'draft' : scheduled ? 'scheduled' : 'queued';

  // Las columnas jsonb que contienen arrays deben serializarse: node-postgres
  // convertiría un array JS en un array de Postgres, no en JSON.
  const JSONB_ARRAYS = new Set(['buttons', 'filters']);
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const created = await one(
    `INSERT INTO notifications (${columns.join(', ')}, status, queued_at)
     VALUES (${placeholders.join(', ')}, '${status}', ${status === 'draft' ? 'NULL' : 'now()'})
     RETURNING *`,
    columns.map((c) => (JSONB_ARRAYS.has(c) ? JSON.stringify(row[c]) : row[c])));

  if (status !== 'draft') {
    await enqueue('notification.dispatch', { notificationId: created.id }, {
      appId: app.id,
      priority: 10,
      runAt: scheduled ? row.send_after : null,
      uniqueKey: `dispatch:${created.id}`,
    });
  }
  logger.info('notificación creada', { notificationId: created.id, appId: app.id, status });
  return { notification: created };
}

/** Cancela una notificación programada o en curso. */
export async function cancelNotification(appId, notificationId) {
  const row = await one('SELECT * FROM notifications WHERE app_id = $1 AND id = $2',
    [appId, notificationId]);
  if (!row) throw notFound('Notificación no encontrada');
  if (['sent', 'canceled'].includes(row.status)) {
    throw conflict(`No se puede cancelar una notificación con estado ${row.status}`);
  }
  await query(
    `UPDATE notifications SET status='canceled', canceled_at=now(), updated_at=now() WHERE id=$1`,
    [notificationId]);
  await cancelByUniqueKey(`dispatch:${notificationId}`);
  await query(
    `UPDATE jobs SET status='canceled', updated_at=now()
     WHERE type='notification.batch' AND status='pending' AND payload->>'notificationId' = $1`,
    [notificationId]);
  await query(
    `UPDATE deliveries SET status='skipped', error_code='canceled'
     WHERE notification_id = $1 AND status='pending'`, [notificationId]);
  logger.info('notificación cancelada', { notificationId });
  return { canceled: true };
}

/** Listado paginado con métricas resumidas. */
export async function listNotifications(appId, { limit = 30, offset = 0, status } = {}) {
  const values = [appId];
  const conds = ['app_id = $1'];
  if (status) { values.push(status); conds.push(`status = $${values.length}`); }
  values.push(Math.min(limit, 200), offset);
  const rows = await many(
    `SELECT id, name, headings, contents, image_url, url, status, channels, target_type,
            recipients, successful, failed, received, clicked, dismissed, converted,
            send_after, queued_at, completed_at, created_at,
            CASE WHEN received > 0 THEN round(clicked::numeric / received, 4) ELSE 0 END AS ctr
     FROM notifications WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const total = await one(`SELECT count(*)::bigint AS n FROM notifications WHERE ${conds.join(' AND ')}`,
    values.slice(0, values.length - 2));
  return { notifications: rows, total: Number(total.n), limit, offset };
}


/**
 * Cierra un test A/B: elige la variante con mejor CTR (o la indicada) y la
 * envía al resto de la audiencia original.
 */
export async function sendAbWinner(app, notificationId, { variantId = null, createdBy = null } = {}) {
  const notification = await one('SELECT * FROM notifications WHERE app_id = $1 AND id = $2',
    [app.id, notificationId]);
  if (!notification) throw notFound('Notificación no encontrada');
  if (!notification.ab_test?.variants?.length) throw badRequest('Esta notificación no es un test A/B');

  const winnerId = variantId || (await one(
    `SELECT variant FROM deliveries WHERE notification_id = $1 AND variant IS NOT NULL
     GROUP BY variant
     ORDER BY count(*) FILTER (WHERE clicked_at IS NOT NULL)::numeric
              / GREATEST(count(*) FILTER (WHERE delivered_at IS NOT NULL), 1) DESC
     LIMIT 1`, [notificationId]))?.variant;
  if (!winnerId) throw badRequest('Todavía no hay datos suficientes para elegir una ganadora');

  const winner = notification.ab_test.variants.find((v) => String(v.id) === String(winnerId));
  if (!winner) throw badRequest(`La variante ${winnerId} no existe`);

  const result = await createNotification(app, {
    headings: winner.headings,
    contents: winner.contents,
    url: winner.url || notification.url,
    image_url: winner.image_url || notification.image_url,
    icon_url: notification.icon_url,
    buttons: notification.buttons,
    channels: notification.channels,
    included_segments: notification.included_segments,
    excluded_segments: notification.excluded_segments,
    filters: notification.filters,
    // Excluye a quien ya recibió el test para no duplicar el mensaje.
    name: `${notification.name || 'A/B'} — ganadora ${winnerId}`,
  }, { createdBy, source: 'ab_winner' });

  await query(
    `UPDATE notifications SET ab_test = jsonb_set(ab_test, '{winner}', to_jsonb($2::text)),
            updated_at = now() WHERE id = $1`, [notificationId, String(winnerId)]);

  return { winner: winnerId, notification_id: result.notification.id };
}

export default {
  buildNotification, createNotification, cancelNotification, listNotifications, sendAbWinner,
};
