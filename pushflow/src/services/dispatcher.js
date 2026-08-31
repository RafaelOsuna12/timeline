/**
 * Despachador de notificaciones.
 *
 * Flujo:
 *   notification.dispatch  → recorre la audiencia, crea filas en `deliveries`
 *                            y encola lotes (respetando huso horario / throttle)
 *   notification.batch     → envía un lote a los proveedores y guarda el resultado
 *   notification.finalize  → cierra la notificación cuando ya no quedan pendientes
 */
import config from '../config.js';
import { one, many, query, transaction } from '../db/index.js';
import { iterateAudience } from './audience.js';
import { buildWebPushPayload, buildFcmMessage } from './payload.js';
import { sendWebPush } from './channels/webpush.js';
import { sendFcm } from './channels/fcm.js';
import { enqueue } from './queue.js';
import { recordDeliveryStats, bumpDailyStats } from './analytics.js';
import { fireWebhook } from './webhooks.js';
import { mapLimit } from '../lib/concurrency.js';
import logger from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Utilidades de programación
// ---------------------------------------------------------------------------

/** Reparto ponderado de variantes A/B. */
function pickVariant(abTest) {
  if (!abTest?.variants?.length) return null;
  const total = abTest.variants.reduce((sum, v) => sum + (Number(v.weight) || 0), 0);
  if (total <= 0) {
    return abTest.variants[Math.floor(Math.random() * abTest.variants.length)].id;
  }
  let roll = Math.random() * total;
  for (const variant of abTest.variants) {
    roll -= Number(variant.weight) || 0;
    if (roll <= 0) return variant.id;
  }
  return abTest.variants[abTest.variants.length - 1].id;
}

/**
 * Momento de envío para una suscripción concreta.
 * - `timezone`: a la hora local indicada (delivery_time_of_day)
 * - `last-active`: a la hora del día en que el usuario suele estar activo
 * - horas silenciosas: aplaza hasta el final de la ventana
 */
export function computeSendTime(notification, subscription, appSettings, now = new Date()) {
  const offsetMin = Number(subscription.timezone_offset ?? 0); // minutos respecto a UTC
  let when = notification.send_after && notification.send_after > now
    ? new Date(notification.send_after) : new Date(now);

  const localMinutesAt = (date) => {
    const local = new Date(date.getTime() + offsetMin * 60000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  };
  const shiftToLocalMinutes = (from, targetMinutes) => {
    const current = localMinutesAt(from);
    let delta = targetMinutes - current;
    if (delta < 0) delta += 1440;                 // mañana a esa hora local
    return new Date(from.getTime() + delta * 60000);
  };

  if (notification.delayed_option === 'timezone' && notification.delivery_time_of_day) {
    const [h, m] = String(notification.delivery_time_of_day).split(':').map(Number);
    when = shiftToLocalMinutes(when, (h || 0) * 60 + (m || 0));
  } else if (notification.delayed_option === 'last-active' && subscription.last_seen_at) {
    const last = new Date(subscription.last_seen_at);
    const localLast = new Date(last.getTime() + offsetMin * 60000);
    when = shiftToLocalMinutes(when, localLast.getUTCHours() * 60 + localLast.getUTCMinutes());
  }

  // Horas silenciosas (configuración de la app, en hora local del dispositivo)
  const quiet = appSettings?.quiet_hours;
  if (notification.respect_quiet_hours && quiet?.enabled) {
    const [sh, sm] = String(quiet.start || '22:00').split(':').map(Number);
    const [eh, em] = String(quiet.end || '08:00').split(':').map(Number);
    const startMin = (sh || 0) * 60 + (sm || 0);
    const endMin = (eh || 0) * 60 + (em || 0);
    const cur = localMinutesAt(when);
    const inQuiet = startMin <= endMin
      ? cur >= startMin && cur < endMin
      : cur >= startMin || cur < endMin;          // ventana que cruza medianoche
    if (inQuiet) when = shiftToLocalMinutes(when, endMin);
  }
  return when;
}

/** Suscripciones que superan el tope diario configurado en la app. */
async function filterFrequencyCap(appId, notification, subscriptionIds, appSettings) {
  const cap = appSettings?.frequency_cap;
  if (!notification.respect_frequency_cap || !cap?.enabled || !cap.max_per_day) {
    return { allowed: subscriptionIds, capped: [] };
  }
  const capped = await many(
    `SELECT subscription_id FROM subscription_counters
     WHERE app_id = $1 AND subscription_id = ANY($2) AND day = current_date AND sent_today >= $3`,
    [appId, subscriptionIds, cap.max_per_day]);
  const cappedSet = new Set(capped.map((r) => r.subscription_id));
  return {
    allowed: subscriptionIds.filter((id) => !cappedSet.has(id)),
    capped: [...cappedSet],
  };
}

// ---------------------------------------------------------------------------
// Paso 1: expandir la audiencia
// ---------------------------------------------------------------------------
export async function dispatchNotification(notificationId) {
  const notification = await one('SELECT * FROM notifications WHERE id = $1', [notificationId]);
  if (!notification) throw new Error(`Notificación ${notificationId} no encontrada`);
  if (['canceled', 'sent', 'failed'].includes(notification.status)) {
    logger.info('despacho omitido', { notificationId, status: notification.status });
    return { skipped: true };
  }
  const app = await one('SELECT * FROM apps WHERE id = $1', [notification.app_id]);
  if (!app) throw new Error(`App ${notification.app_id} no encontrada`);

  await query(
    `UPDATE notifications SET status='sending', started_at=COALESCE(started_at, now()), updated_at=now()
     WHERE id=$1`, [notificationId]);

  const target = {
    targetType: notification.target_type,
    includedSegments: notification.included_segments,
    excludedSegments: notification.excluded_segments,
    filters: notification.filters,
    includeSubscriptionIds: notification.include_subscription_ids,
    includeExternalIds: notification.include_external_ids,
    channels: notification.channels,
    samplePercent: notification.sample_percent,
    excludeDeliveredFor: notification.exclude_delivered_for,
  };

  const now = new Date();
  let recipients = 0, skipped = 0, batchIndex = 0;
  const throttle = notification.throttle_per_minute;

  for await (const batch of iterateAudience(notification.app_id, target, config.worker.batchSize)) {
    const ids = batch.map((s) => s.id);
    const { allowed, capped } = await filterFrequencyCap(
      notification.app_id, notification, ids, app.settings);
    skipped += capped.length;

    if (capped.length) {
      await query(
        `INSERT INTO deliveries (notification_id, app_id, subscription_id, channel, status, error_code)
         SELECT $1, $2, s.id, s.channel, 'skipped', 'frequency_cap'
         FROM subscriptions s WHERE s.id = ANY($3)`,
        [notificationId, notification.app_id, capped]);
    }
    if (allowed.length === 0) { batchIndex++; continue; }

    const allowedSet = new Set(allowed);
    const rows = batch.filter((s) => allowedSet.has(s.id));

    // Agrupa por instante de envío (redondeado al minuto) para respetar
    // husos horarios y horas silenciosas sin crear un trabajo por dispositivo.
    const groups = new Map();
    for (const sub of rows) {
      const when = computeSendTime(notification, sub, app.settings, now);
      const key = Math.floor(when.getTime() / 60000) * 60000;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sub);
    }

    for (const [timeKey, group] of groups) {
      const variants = group.map(() => pickVariant(notification.ab_test));
      const deliveryRows = await many(
        `INSERT INTO deliveries (notification_id, app_id, subscription_id, user_id, channel, variant, status)
         SELECT $1, $2, s.id, s.user_id, s.channel, v.variant, 'pending'
         FROM unnest($3::uuid[], $4::text[]) AS v(sub_id, variant)
         JOIN subscriptions s ON s.id = v.sub_id
         RETURNING id`,
        [notificationId, notification.app_id, group.map((s) => s.id), variants]);

      let runAt = new Date(Math.max(timeKey, now.getTime()));
      if (throttle && throttle > 0) {
        const minutesOffset = Math.floor((recipients) / throttle);
        runAt = new Date(runAt.getTime() + minutesOffset * 60000);
      }

      await enqueue('notification.batch', {
        notificationId,
        deliveryIds: deliveryRows.map((r) => r.id),
      }, {
        appId: notification.app_id,
        priority: 50,
        runAt,
        maxAttempts: 3,
      });
      recipients += group.length;
    }
    batchIndex++;
  }

  await query(
    `UPDATE notifications SET recipients = $2, updated_at = now() WHERE id = $1`,
    [notificationId, recipients]);

  // Cierre diferido: comprueba si quedan entregas pendientes.
  await enqueue('notification.finalize', { notificationId }, {
    appId: notification.app_id, priority: 200,
    runAt: new Date(Date.now() + 30000),
    uniqueKey: `finalize:${notificationId}`,
  });

  logger.info('notificación expandida', { notificationId, recipients, skipped, batches: batchIndex });

  if (recipients === 0) {
    await query(
      `UPDATE notifications SET status='sent', completed_at=now(), updated_at=now() WHERE id=$1`,
      [notificationId]);
  }
  return { recipients, skipped };
}

// ---------------------------------------------------------------------------
// Paso 2: enviar un lote
// ---------------------------------------------------------------------------
export async function sendBatch({ notificationId, deliveryIds }) {
  if (!deliveryIds?.length) return { sent: 0, failed: 0 };

  const notification = await one('SELECT * FROM notifications WHERE id = $1', [notificationId]);
  if (!notification) throw new Error(`Notificación ${notificationId} no encontrada`);
  if (notification.status === 'canceled') {
    await query(
      `UPDATE deliveries SET status='skipped', error_code='canceled'
       WHERE id = ANY($1) AND status='pending'`, [deliveryIds]);
    return { canceled: true };
  }
  const app = await one('SELECT * FROM apps WHERE id = $1', [notification.app_id]);

  const items = await many(
    `SELECT d.id AS delivery_id, d.variant, s.*
     FROM deliveries d
     JOIN subscriptions s ON s.id = d.subscription_id
     WHERE d.id = ANY($1) AND d.status = 'pending'`,
    [deliveryIds]);
  if (items.length === 0) return { sent: 0, failed: 0 };

  const results = await mapLimit(items, config.worker.sendConcurrency, async (item) => {
    try {
      if (item.channel === 'web_push') {
        const payload = buildWebPushPayload(notification, item, {
          variant: item.variant, deliveryId: item.delivery_id,
        });
        const res = await sendWebPush(app, item, payload, {
          ttl: notification.ttl,
          priority: notification.priority,
          topic: notification.web_push_topic || notification.collapse_id || undefined,
        });
        return { item, res };
      }
      if (item.channel === 'android') {
        const message = buildFcmMessage(notification, item, {
          variant: item.variant, deliveryId: item.delivery_id,
        });
        const res = await sendFcm(app, message);
        return { item, res };
      }
      return { item, res: { ok: false, permanent: true, errorCode: 'unsupported_channel',
                            error: `Canal no soportado: ${item.channel}` } };
    } catch (err) {
      return { item, res: { ok: false, permanent: false, errorCode: 'exception', error: err.message } };
    }
  });

  // Errores de configuración de la app: la entrega falla, pero el dispositivo
  // sigue siendo válido. Invalidarlo borraría toda la audiencia por un ajuste
  // pendiente (por ejemplo, credenciales de FCM sin subir).
  const APP_LEVEL_ERRORS = new Set([
    'no_fcm_credentials', 'no_vapid', 'fcm_auth_error', 'unsupported_channel',
  ]);

  const sent = [], failed = [], invalidate = [];
  for (const { item, res } of results) {
    if (res.ok) {
      sent.push({ id: item.delivery_id, providerId: res.providerId || null });
    } else {
      failed.push({ id: item.delivery_id, code: res.errorCode, message: res.error });
      if (res.permanent && !APP_LEVEL_ERRORS.has(res.errorCode)) {
        invalidate.push({ id: item.id, reason: res.errorCode });
      }
    }
  }

  await transaction(async (client) => {
    if (sent.length) {
      await client.query(
        `UPDATE deliveries d SET status='sent', sent_at=now(), provider_id=v.provider_id
         FROM unnest($1::bigint[], $2::text[]) AS v(id, provider_id)
         WHERE d.id = v.id`,
        [sent.map((s) => s.id), sent.map((s) => s.providerId)]);

      await client.query(
        `INSERT INTO subscription_counters (subscription_id, app_id, day, sent_today, sent_total, last_sent_at)
         SELECT d.subscription_id, d.app_id, current_date, 1, 1, now()
         FROM deliveries d WHERE d.id = ANY($1)
         ON CONFLICT (subscription_id) DO UPDATE SET
           sent_today = CASE WHEN subscription_counters.day = current_date
                             THEN subscription_counters.sent_today + 1 ELSE 1 END,
           day = current_date,
           sent_total = subscription_counters.sent_total + 1,
           last_sent_at = now()`,
        [sent.map((s) => s.id)]);

      await client.query(
        `UPDATE subscriptions SET last_notification_at = now()
         WHERE id IN (SELECT subscription_id FROM deliveries WHERE id = ANY($1))`,
        [sent.map((s) => s.id)]);
    }

    if (failed.length) {
      await client.query(
        `UPDATE deliveries d SET status='failed', error_code=v.code, error_message=v.message
         FROM unnest($1::bigint[], $2::text[], $3::text[]) AS v(id, code, message)
         WHERE d.id = v.id`,
        [failed.map((f) => f.id), failed.map((f) => f.code), failed.map((f) => f.message)]);
    }

    if (invalidate.length) {
      await client.query(
        `UPDATE subscriptions SET invalid = true, invalid_reason = v.reason,
                                  invalidated_at = now(), subscribed = false, updated_at = now()
         FROM unnest($1::uuid[], $2::text[]) AS v(id, reason)
         WHERE subscriptions.id = v.id`,
        [invalidate.map((i) => i.id), invalidate.map((i) => i.reason)]);
    }

    await client.query(
      `UPDATE notifications
       SET successful = successful + $2, failed = failed + $3, updated_at = now()
       WHERE id = $1`,
      [notificationId, sent.length, failed.length]);
  });

  await recordDeliveryStats(notificationId, { sent: sent.length, failed: failed.length });
  await bumpDailyStats(notification.app_id, notification.channels?.[0] || 'web_push', {
    sent: sent.length, failed: failed.length,
  });

  logger.info('lote enviado', {
    notificationId, sent: sent.length, failed: failed.length, invalidated: invalidate.length,
  });

  if (sent.length) {
    await fireWebhook(notification.app_id, 'notification.sent', {
      notification_id: notificationId, sent: sent.length, failed: failed.length,
    });
  }
  return { sent: sent.length, failed: failed.length };
}

// ---------------------------------------------------------------------------
// Paso 3: cerrar la notificación
// ---------------------------------------------------------------------------
export async function finalizeNotification({ notificationId }) {
  const pending = await one(
    `SELECT count(*)::int AS n FROM deliveries WHERE notification_id = $1 AND status = 'pending'`,
    [notificationId]);
  const queued = await one(
    `SELECT count(*)::int AS n FROM jobs
     WHERE type = 'notification.batch' AND status IN ('pending','running')
       AND payload->>'notificationId' = $1`, [notificationId]);

  if (pending.n > 0 || queued.n > 0) {
    await enqueue('notification.finalize', { notificationId }, {
      priority: 200,
      runAt: new Date(Date.now() + 60000),
      uniqueKey: `finalize:${notificationId}`,
    });
    return { pending: pending.n, queued: queued.n };
  }

  await query(
    `UPDATE notifications SET status = CASE WHEN status IN ('canceled','failed') THEN status ELSE 'sent' END,
                              completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE id = $1`, [notificationId]);
  logger.info('notificación completada', { notificationId });
  return { done: true };
}

export default { dispatchNotification, sendBatch, finalizeNotification, computeSendTime };
