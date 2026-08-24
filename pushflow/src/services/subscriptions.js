/**
 * Alta y mantenimiento de suscripciones (dispositivos).
 *
 * Una "suscripción" es un dispositivo concreto: un navegador con Web Push o una
 * instalación de la app Android con su token FCM. Varias suscripciones pueden
 * apuntar al mismo usuario final mediante `external_user_id`.
 */
import { one, many, query, transaction } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { parseUserAgent } from '../lib/useragent.js';
import { sanitizeTags } from '../lib/validate.js';
import { recordEvent, bumpDailyStats } from './analytics.js';
import { fireWebhook } from './webhooks.js';
import { enqueue } from './queue.js';
import logger from '../lib/logger.js';

/** Normaliza la carga que llega del SDK web o Android. */
function normalize(input, context = {}) {
  const ua = parseUserAgent(context.userAgent || input.user_agent || '');
  const channel = input.channel
    || (input.fcm_token ? 'android' : input.endpoint || input.subscription?.endpoint ? 'web_push' : null);
  if (!channel) throw badRequest('No se pudo determinar el canal: falta `endpoint` o `fcm_token`');

  const webSub = input.subscription || {};
  const endpoint = input.endpoint || webSub.endpoint || null;
  const keys = input.keys || webSub.keys || {};

  if (channel === 'web_push') {
    if (!endpoint) throw badRequest('`endpoint` es obligatorio para web_push');
    if (!keys.p256dh || !keys.auth) throw badRequest('Faltan las claves `p256dh` y `auth`');
  }
  if (channel === 'android' && !input.fcm_token) {
    throw badRequest('`fcm_token` es obligatorio para el canal android');
  }

  const offset = input.timezone_offset != null ? Number(input.timezone_offset) : null;
  return {
    channel,
    endpoint,
    p256dh: channel === 'web_push' ? keys.p256dh : null,
    auth_key: channel === 'web_push' ? keys.auth : null,
    fcm_token: channel === 'android' ? input.fcm_token : null,
    external_user_id: input.external_user_id || input.external_id || null,
    device_model: input.device_model || null,
    device_os: input.device_os || ua.os || null,
    os_version: input.os_version || ua.osVersion || null,
    browser_name: input.browser_name || ua.browserName || null,
    browser_version: input.browser_version || ua.browserVersion || null,
    device_type: input.device_type || (channel === 'android' ? 'android' : ua.browserName) || null,
    sdk_version: input.sdk_version || null,
    app_version: input.app_version || null,
    language: (input.language || context.language || '').toLowerCase().slice(0, 12) || null,
    timezone: input.timezone || null,
    timezone_offset: Number.isFinite(offset) ? offset : null,
    country: (input.country || context.country || '').toUpperCase().slice(0, 2) || null,
    region: input.region || null,
    city: input.city || context.city || null,
    lat: input.lat != null ? Number(input.lat) : null,
    lng: (input.lng ?? input.long) != null ? Number(input.lng ?? input.long) : null,
    ip: context.ip || null,
    test_type: input.test_type != null ? Number(input.test_type) : null,
    tags: sanitizeTags(input.tags),
  };
}

/**
 * Crea o actualiza una suscripción (idempotente por endpoint/token).
 * Devuelve { subscription, created }.
 */
export async function upsertSubscription(appId, input, context = {}) {
  const data = normalize(input, context);

  const existing = data.channel === 'web_push'
    ? await one('SELECT * FROM subscriptions WHERE app_id = $1 AND endpoint = $2', [appId, data.endpoint])
    : await one('SELECT * FROM subscriptions WHERE app_id = $1 AND fcm_token = $2', [appId, data.fcm_token]);

  const userId = data.external_user_id
    ? await ensureEndUser(appId, data.external_user_id, { language: data.language, country: data.country })
    : existing?.user_id || null;

  if (existing) {
    const merged = { ...(existing.tags || {}) };
    for (const [key, value] of Object.entries(data.tags)) {
      if (value === null) delete merged[key]; else merged[key] = value;
    }
    const updated = await one(
      `UPDATE subscriptions SET
         p256dh = COALESCE($3, p256dh), auth_key = COALESCE($4, auth_key),
         fcm_token = COALESCE($5, fcm_token),
         user_id = COALESCE($6, user_id),
         external_user_id = COALESCE($7, external_user_id),
         device_model = COALESCE($8, device_model), device_os = COALESCE($9, device_os),
         os_version = COALESCE($10, os_version), browser_name = COALESCE($11, browser_name),
         browser_version = COALESCE($12, browser_version), device_type = COALESCE($13, device_type),
         sdk_version = COALESCE($14, sdk_version), app_version = COALESCE($15, app_version),
         language = COALESCE($16, language), timezone = COALESCE($17, timezone),
         timezone_offset = COALESCE($18, timezone_offset), country = COALESCE($19, country),
         region = COALESCE($20, region), city = COALESCE($21, city),
         lat = COALESCE($22, lat), lng = COALESCE($23, lng), ip = COALESCE($24, ip),
         test_type = COALESCE($25, test_type),
         tags = $26,
         subscribed = true, opted_out = false, invalid = false, invalid_reason = NULL,
         unsubscribed_at = NULL, last_seen_at = now(), updated_at = now()
       WHERE id = $1 AND app_id = $2
       RETURNING *`,
      [existing.id, appId, data.p256dh, data.auth_key, data.fcm_token, userId, data.external_user_id,
       data.device_model, data.device_os, data.os_version, data.browser_name, data.browser_version,
       data.device_type, data.sdk_version, data.app_version, data.language, data.timezone,
       data.timezone_offset, data.country, data.region, data.city, data.lat, data.lng, data.ip,
       data.test_type, merged]);

    // Reactivación de una suscripción que se había dado de baja.
    if (!existing.subscribed || existing.invalid || existing.opted_out) {
      await bumpDailyStats(appId, data.channel, { subs_added: 1 });
      await recordEvent(appId, { type: 'subscribed', subscriptionId: updated.id,
        channel: data.channel, country: data.country, language: data.language });
    }
    return { subscription: updated, created: false };
  }

  const created = await one(
    `INSERT INTO subscriptions (
       app_id, user_id, external_user_id, channel, endpoint, p256dh, auth_key, fcm_token,
       device_model, device_os, os_version, browser_name, browser_version, device_type,
       sdk_version, app_version, language, timezone, timezone_offset, country, region, city,
       lat, lng, ip, test_type, tags, last_session_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
             $23,$24,$25,$26,$27, now())
     RETURNING *`,
    [appId, userId, data.external_user_id, data.channel, data.endpoint, data.p256dh, data.auth_key,
     data.fcm_token, data.device_model, data.device_os, data.os_version, data.browser_name,
     data.browser_version, data.device_type, data.sdk_version, data.app_version, data.language,
     data.timezone, data.timezone_offset, data.country, data.region, data.city, data.lat, data.lng,
     data.ip, data.test_type, data.tags]);

  await bumpDailyStats(appId, data.channel, { subs_added: 1 });
  await recordEvent(appId, { type: 'subscribed', subscriptionId: created.id, channel: data.channel,
    country: data.country, language: data.language, browserName: data.browser_name, os: data.device_os });
  await fireWebhook(appId, 'subscription.created', {
    subscription_id: created.id, channel: created.channel, external_user_id: created.external_user_id });

  // Dispara automatizaciones con trigger `subscription_created`.
  await enqueue('automation.trigger', {
    appId, event: 'subscription_created', subscriptionId: created.id,
  }, { appId, priority: 80 });

  // Notificación de bienvenida, si la app la tiene configurada.
  await enqueue('subscription.welcome', { appId, subscriptionId: created.id },
    { appId, priority: 60, runAt: new Date(Date.now() + 15000) });

  logger.info('suscripción creada', { appId, subscriptionId: created.id, channel: created.channel });
  return { subscription: created, created: true };
}

/** Crea (o reutiliza) el usuario final asociado a un external_id. */
export async function ensureEndUser(appId, externalId, extra = {}) {
  if (!externalId) return null;
  const row = await one(
    `INSERT INTO end_users (app_id, external_id, language, country)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (app_id, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET last_seen_at = now(), updated_at = now(),
                   language = COALESCE(EXCLUDED.language, end_users.language),
                   country = COALESCE(EXCLUDED.country, end_users.country)
     RETURNING id`,
    [appId, String(externalId), extra.language || null, extra.country || null]);
  return row.id;
}

/** Actualiza parcialmente una suscripción existente. */
export async function updateSubscription(appId, subscriptionId, patch) {
  const current = await one('SELECT * FROM subscriptions WHERE app_id = $1 AND id = $2',
    [appId, subscriptionId]);
  if (!current) throw badRequest('Suscripción no encontrada');

  const fields = [], values = [appId, subscriptionId];
  const set = (col, value) => { values.push(value); fields.push(`${col} = $${values.length}`); };

  if (patch.tags !== undefined) {
    const merged = { ...(current.tags || {}) };
    for (const [key, value] of Object.entries(sanitizeTags(patch.tags))) {
      if (value === null) delete merged[key]; else merged[key] = value;
    }
    set('tags', merged);
  }
  if (patch.external_user_id !== undefined) {
    set('external_user_id', patch.external_user_id);
    set('user_id', await ensureEndUser(appId, patch.external_user_id));
  }
  for (const col of ['language', 'timezone', 'country', 'region', 'city', 'app_version',
                     'sdk_version', 'device_model', 'test_type']) {
    if (patch[col] !== undefined) set(col, patch[col]);
  }
  if (patch.timezone_offset !== undefined) set('timezone_offset', Number(patch.timezone_offset));
  if (patch.lat !== undefined) set('lat', Number(patch.lat));
  if (patch.lng !== undefined || patch.long !== undefined) set('lng', Number(patch.lng ?? patch.long));

  if (patch.subscribed !== undefined) {
    const subscribed = Boolean(patch.subscribed);
    set('subscribed', subscribed);
    set('opted_out', !subscribed);
    set('unsubscribed_at', subscribed ? null : new Date());
    await bumpDailyStats(appId, current.channel, subscribed ? { subs_added: 1 } : { subs_removed: 1 });
    await recordEvent(appId, {
      type: subscribed ? 'subscribed' : 'unsubscribed',
      subscriptionId, channel: current.channel });
  }

  if (fields.length === 0) return current;
  fields.push('last_seen_at = now()', 'updated_at = now()');
  return one(
    `UPDATE subscriptions SET ${fields.join(', ')} WHERE app_id = $1 AND id = $2 RETURNING *`, values);
}

/** Baja voluntaria (el registro se conserva para la analítica). */
export async function unsubscribe(appId, subscriptionId, reason = 'user_request') {
  const row = await one(
    `UPDATE subscriptions SET subscribed = false, opted_out = true, unsubscribed_at = now(),
                              invalid_reason = $3, updated_at = now()
     WHERE app_id = $1 AND id = $2 RETURNING *`, [appId, subscriptionId, reason]);
  if (!row) return null;
  await bumpDailyStats(appId, row.channel, { subs_removed: 1 });
  await recordEvent(appId, { type: 'unsubscribed', subscriptionId, channel: row.channel });
  await fireWebhook(appId, 'subscription.removed', { subscription_id: subscriptionId, reason });
  return row;
}

/** Registra una sesión (uso para segmentar por actividad y para in-app). */
export async function trackSession(appId, subscriptionId, { durationSec = 0, start = true } = {}) {
  const row = await one(
    `UPDATE subscriptions SET
       session_count = session_count + $3,
       total_duration_sec = total_duration_sec + $4,
       last_session_at = now(), last_seen_at = now(), updated_at = now()
     WHERE app_id = $1 AND id = $2
     RETURNING id, channel, session_count, total_duration_sec`,
    [appId, subscriptionId, start ? 1 : 0, Math.max(0, Math.floor(durationSec))]);
  if (!row) return null;
  if (start) {
    await recordEvent(appId, { type: 'session_start', subscriptionId, channel: row.channel });
    await bumpDailyStats(appId, row.channel, { sessions: 1 });
  } else {
    await recordEvent(appId, { type: 'session_end', subscriptionId, channel: row.channel,
      value: durationSec });
  }
  return row;
}

/** Aplica tags a todas las suscripciones de un external_user_id. */
export async function tagByExternalId(appId, externalUserId, tags) {
  const clean = sanitizeTags(tags);
  const removals = Object.entries(clean).filter(([, v]) => v === null).map(([k]) => k);
  const additions = Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null));
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE subscriptions
       SET tags = (tags || $3::jsonb) - $4::text[], updated_at = now()
       WHERE app_id = $1 AND external_user_id = $2
       RETURNING id`,
      [appId, String(externalUserId), JSON.stringify(additions), removals]);
    await client.query(
      `UPDATE end_users SET tags = (tags || $3::jsonb) - $4::text[], updated_at = now()
       WHERE app_id = $1 AND external_id = $2`,
      [appId, String(externalUserId), JSON.stringify(additions), removals]);
    return rows.length;
  });
}

/** Listado paginado para el panel. */
export async function listSubscriptions(appId, { limit = 50, offset = 0, search, channel, status } = {}) {
  const values = [appId];
  const conds = ['app_id = $1'];
  if (channel) { values.push(channel); conds.push(`channel = $${values.length}`); }
  if (status === 'active') conds.push('subscribed AND NOT invalid AND NOT opted_out');
  else if (status === 'unsubscribed') conds.push('(NOT subscribed OR opted_out)');
  else if (status === 'invalid') conds.push('invalid');
  if (search) {
    values.push(`%${search}%`);
    conds.push(`(external_user_id ILIKE $${values.length} OR id::text ILIKE $${values.length}
                 OR country ILIKE $${values.length} OR device_model ILIKE $${values.length})`);
  }
  values.push(Math.min(limit, 500), offset);
  const rows = await many(
    `SELECT id, channel, external_user_id, device_type, browser_name, device_os, country, city,
            language, timezone, subscribed, invalid, opted_out, tags, session_count,
            last_seen_at, created_at
     FROM subscriptions WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  const total = await one(
    `SELECT count(*)::bigint AS n FROM subscriptions WHERE ${conds.join(' AND ')}`,
    values.slice(0, values.length - 2));
  return { subscriptions: rows, total: Number(total.n), limit, offset };
}

/** Purga suscripciones inválidas antiguas. */
export async function purgeInvalid(appId, olderThanDays = 90) {
  const { rowCount } = await query(
    `DELETE FROM subscriptions
     WHERE app_id = $1 AND invalid AND invalidated_at < now() - ($2 || ' days')::interval`,
    [appId, olderThanDays]);
  return rowCount;
}

export default {
  upsertSubscription, updateSubscription, unsubscribe, trackSession,
  tagByExternalId, listSubscriptions, ensureEndUser, purgeInvalid,
};
