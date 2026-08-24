/**
 * Analítica: registro de eventos, agregados y consultas para el panel.
 *
 * Eventos soportados (tabla `events`):
 *   displayed | clicked | dismissed | action_click | session_start | session_end
 *   subscribed | unsubscribed | permission_prompt | outcome
 */
import { one, many, query } from '../db/index.js';
import logger from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export async function recordEvent(appId, event) {
  const row = await one(
    `INSERT INTO events (app_id, subscription_id, user_id, notification_id, type, name, value,
                         channel, device_type, browser_name, os, country, city, language,
                         url, action_id, properties)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, created_at`,
    [
      appId, event.subscriptionId || null, event.userId || null, event.notificationId || null,
      event.type, event.name || null, event.value ?? null,
      event.channel || null, event.deviceType || null, event.browserName || null, event.os || null,
      event.country || null, event.city || null, event.language || null,
      event.url || null, event.actionId || null, event.properties || {},
    ]);
  return row;
}

/** Serie horaria por notificación (gráfico de rendimiento). */
export async function recordDeliveryStats(notificationId, deltas) {
  const cols = ['sent', 'delivered', 'clicked', 'dismissed', 'failed'];
  const values = cols.map((c) => Number(deltas[c] || 0));
  if (values.every((v) => v === 0)) return;
  await query(
    `INSERT INTO notification_stats_hourly (notification_id, hour, sent, delivered, clicked, dismissed, failed)
     VALUES ($1, date_trunc('hour', now()), $2,$3,$4,$5,$6)
     ON CONFLICT (notification_id, hour) DO UPDATE SET
       sent = notification_stats_hourly.sent + EXCLUDED.sent,
       delivered = notification_stats_hourly.delivered + EXCLUDED.delivered,
       clicked = notification_stats_hourly.clicked + EXCLUDED.clicked,
       dismissed = notification_stats_hourly.dismissed + EXCLUDED.dismissed,
       failed = notification_stats_hourly.failed + EXCLUDED.failed`,
    [notificationId, ...values]);
}

/** Agregado diario por app y canal. */
export async function bumpDailyStats(appId, channel, deltas) {
  const cols = ['subs_added', 'subs_removed', 'sent', 'delivered', 'clicked',
                'dismissed', 'failed', 'sessions', 'outcomes'];
  const values = cols.map((c) => Number(deltas[c] || 0));
  const outcomeValue = Number(deltas.outcome_value || 0);
  if (values.every((v) => v === 0) && outcomeValue === 0) return;
  await query(
    `INSERT INTO daily_stats (app_id, day, channel, ${cols.join(', ')}, outcome_value)
     VALUES ($1, current_date, $2, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (app_id, day, channel) DO UPDATE SET
       ${cols.map((c) => `${c} = daily_stats.${c} + EXCLUDED.${c}`).join(', ')},
       outcome_value = daily_stats.outcome_value + EXCLUDED.outcome_value,
       updated_at = now()`,
    [appId, channel || 'web_push', ...values, outcomeValue]);
}

/** Recepción confirmada en el dispositivo. */
export async function trackDisplayed({ appId, notificationId, subscriptionId, deliveryId, meta = {} }) {
  const delivery = await resolveDelivery({ deliveryId, notificationId, subscriptionId });
  if (delivery) {
    const { rowCount } = await query(
      `UPDATE deliveries SET status = CASE WHEN status IN ('clicked','dismissed') THEN status ELSE 'delivered' END,
                             delivered_at = COALESCE(delivered_at, now())
       WHERE id = $1 AND created_at = $2::timestamptz AND delivered_at IS NULL`,
      [delivery.id, delivery.created_at_key]);
    if (rowCount > 0) {
      await query('UPDATE notifications SET received = received + 1, updated_at = now() WHERE id = $1',
        [delivery.notification_id]);
      await recordDeliveryStats(delivery.notification_id, { delivered: 1 });
      await bumpDailyStats(appId, delivery.channel, { delivered: 1 });
    }
  }
  await recordEvent(appId, {
    type: 'displayed', notificationId, subscriptionId,
    channel: delivery?.channel, ...meta,
  });
  return { ok: true };
}

/** Clic en la notificación o en uno de sus botones. */
export async function trackClicked({ appId, notificationId, subscriptionId, deliveryId, actionId, url, meta = {} }) {
  const delivery = await resolveDelivery({ deliveryId, notificationId, subscriptionId });
  let firstClick = false;
  if (delivery) {
    const { rowCount } = await query(
      `UPDATE deliveries SET status='clicked', clicked_at = now(), action_id = COALESCE($3, action_id),
                             delivered_at = COALESCE(delivered_at, now())
       WHERE id = $1 AND created_at = $2::timestamptz AND clicked_at IS NULL`,
      [delivery.id, delivery.created_at_key, actionId || null]);
    firstClick = rowCount > 0;
    if (firstClick) {
      await query('UPDATE notifications SET clicked = clicked + 1, updated_at = now() WHERE id = $1',
        [delivery.notification_id]);
      await recordDeliveryStats(delivery.notification_id, { clicked: 1 });
      await bumpDailyStats(appId, delivery.channel, { clicked: 1 });
    }
  }
  await recordEvent(appId, {
    type: actionId ? 'action_click' : 'clicked',
    notificationId, subscriptionId, actionId, url,
    channel: delivery?.channel, ...meta,
  });
  return { ok: true, firstClick };
}

/** Descarte de la notificación sin abrirla. */
export async function trackDismissed({ appId, notificationId, subscriptionId, deliveryId, meta = {} }) {
  const delivery = await resolveDelivery({ deliveryId, notificationId, subscriptionId });
  if (delivery) {
    const { rowCount } = await query(
      `UPDATE deliveries SET status = CASE WHEN status='clicked' THEN status ELSE 'dismissed' END,
                             dismissed_at = COALESCE(dismissed_at, now())
       WHERE id = $1 AND created_at = $2::timestamptz AND dismissed_at IS NULL`,
      [delivery.id, delivery.created_at_key]);
    if (rowCount > 0) {
      await query('UPDATE notifications SET dismissed = dismissed + 1, updated_at = now() WHERE id = $1',
        [delivery.notification_id]);
      await recordDeliveryStats(delivery.notification_id, { dismissed: 1 });
      await bumpDailyStats(appId, delivery.channel, { dismissed: 1 });
    }
  }
  await recordEvent(appId, { type: 'dismissed', notificationId, subscriptionId,
                             channel: delivery?.channel, ...meta });
  return { ok: true };
}

/**
 * Outcome/conversión con atribución:
 *   - `direct`: el usuario pulsó una notificación dentro de la ventana
 *   - `influenced`: recibió una notificación dentro de la ventana pero no la pulsó
 *   - `unattributed`: sin notificación reciente
 */
export async function trackOutcome({ appId, subscriptionId, name, value = 1, notificationId = null, meta = {} }) {
  const definition = await one(
    'SELECT id, attribution_window_min FROM outcomes WHERE app_id = $1 AND lower(name) = lower($2)',
    [appId, name]);
  const windowMin = definition?.attribution_window_min ?? 1440;

  let attribution = 'unattributed';
  let attributedNotification = notificationId;

  if (!attributedNotification && subscriptionId) {
    const clicked = await one(
      `SELECT notification_id FROM deliveries
       WHERE subscription_id = $1 AND clicked_at > now() - ($2 || ' minutes')::interval
       ORDER BY clicked_at DESC LIMIT 1`, [subscriptionId, windowMin]);
    if (clicked) { attribution = 'direct'; attributedNotification = clicked.notification_id; }
    else {
      const received = await one(
        `SELECT notification_id FROM deliveries
         WHERE subscription_id = $1 AND sent_at > now() - ($2 || ' minutes')::interval
         ORDER BY sent_at DESC LIMIT 1`, [subscriptionId, windowMin]);
      if (received) { attribution = 'influenced'; attributedNotification = received.notification_id; }
    }
  } else if (attributedNotification) {
    attribution = 'direct';
  }

  await query(
    `INSERT INTO outcome_attributions (app_id, outcome_id, name, notification_id, subscription_id, attribution, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [appId, definition?.id || null, name, attributedNotification, subscriptionId || null, attribution, value]);

  if (attributedNotification && attribution === 'direct') {
    await query('UPDATE notifications SET converted = converted + 1, updated_at = now() WHERE id = $1',
      [attributedNotification]);
  }
  await recordEvent(appId, {
    type: 'outcome', name, value, subscriptionId,
    notificationId: attributedNotification,
    properties: { attribution, ...(meta.properties || {}) },
    ...meta,
  });
  await bumpDailyStats(appId, meta.channel || 'web_push', { outcomes: 1, outcome_value: value });
  return { attribution, notificationId: attributedNotification };
}

/** Localiza la entrega concreta a la que se refiere un evento. */
async function resolveDelivery({ deliveryId, notificationId, subscriptionId }) {
  // `created_at` se devuelve como texto: es la clave de partición y un Date de
  // JS perdería los microsegundos, con lo que el UPDATE no encontraría la fila.
  const columns = `id, created_at::text AS created_at_key, notification_id, channel,
                   delivered_at, clicked_at`;
  if (deliveryId) {
    return one(`SELECT ${columns} FROM deliveries WHERE id = $1`, [deliveryId]);
  }
  if (notificationId && subscriptionId) {
    return one(
      `SELECT ${columns} FROM deliveries WHERE notification_id = $1 AND subscription_id = $2
       ORDER BY created_at DESC LIMIT 1`, [notificationId, subscriptionId]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lectura (panel y API de analítica)
// ---------------------------------------------------------------------------

export async function appOverview(appId, days = 30) {
  const [audience, totals, series] = await Promise.all([
    one(
      `SELECT
         count(*) FILTER (WHERE subscribed AND NOT invalid AND NOT opted_out) AS active,
         count(*) FILTER (WHERE channel='web_push' AND subscribed AND NOT invalid AND NOT opted_out) AS web,
         count(*) FILTER (WHERE channel='android' AND subscribed AND NOT invalid AND NOT opted_out) AS android,
         count(*) FILTER (WHERE NOT subscribed OR opted_out) AS unsubscribed,
         count(*) FILTER (WHERE invalid) AS invalid,
         count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS new_24h,
         count(*) AS total
       FROM subscriptions WHERE app_id = $1`, [appId]),
    one(
      `SELECT COALESCE(sum(sent),0) AS sent, COALESCE(sum(delivered),0) AS delivered,
              COALESCE(sum(clicked),0) AS clicked, COALESCE(sum(dismissed),0) AS dismissed,
              COALESCE(sum(failed),0) AS failed, COALESCE(sum(outcomes),0) AS outcomes,
              COALESCE(sum(outcome_value),0) AS outcome_value
       FROM daily_stats WHERE app_id = $1 AND day > current_date - $2::int`, [appId, days]),
    many(
      `SELECT day, sum(sent)::bigint AS sent, sum(delivered)::bigint AS delivered,
              sum(clicked)::bigint AS clicked, sum(failed)::bigint AS failed,
              sum(subs_added)::bigint AS subs_added, sum(subs_removed)::bigint AS subs_removed
       FROM daily_stats WHERE app_id = $1 AND day > current_date - $2::int
       GROUP BY day ORDER BY day`, [appId, days]),
  ]);

  const ctr = totals.delivered > 0 ? totals.clicked / totals.delivered : 0;
  const deliveryRate = totals.sent > 0 ? totals.delivered / totals.sent : 0;
  return {
    audience,
    totals: { ...totals, ctr: Number(ctr.toFixed(4)), delivery_rate: Number(deliveryRate.toFixed(4)) },
    series,
  };
}

/** Desgloses: país, navegador, SO, idioma, canal. */
export async function audienceBreakdown(appId, dimension = 'country', limit = 20) {
  const columns = {
    country: 'country', language: 'language', browser: 'browser_name',
    os: 'device_os', device: 'device_type', channel: 'channel', city: 'city',
  };
  const col = columns[dimension];
  if (!col) throw new Error(`Dimensión desconocida: ${dimension}`);
  return many(
    `SELECT COALESCE(${col}, 'desconocido') AS label, count(*)::bigint AS value
     FROM subscriptions
     WHERE app_id = $1 AND subscribed AND NOT invalid AND NOT opted_out
     GROUP BY 1 ORDER BY value DESC LIMIT $2`, [appId, limit]);
}

/** Métricas detalladas de una notificación, incluidos los desgloses de clics. */
export async function notificationReport(notificationId) {
  const notification = await one('SELECT * FROM notifications WHERE id = $1', [notificationId]);
  if (!notification) return null;

  const [byStatus, hourly, byVariant, byCountry, byAction, outcomes, errors] = await Promise.all([
    many(`SELECT status, count(*)::bigint AS n FROM deliveries WHERE notification_id = $1 GROUP BY status`,
      [notificationId]),
    many(`SELECT hour, sent, delivered, clicked, dismissed, failed
          FROM notification_stats_hourly WHERE notification_id = $1 ORDER BY hour`, [notificationId]),
    many(`SELECT COALESCE(variant,'-') AS variant,
                 count(*)::bigint AS sent,
                 count(*) FILTER (WHERE delivered_at IS NOT NULL)::bigint AS delivered,
                 count(*) FILTER (WHERE clicked_at IS NOT NULL)::bigint AS clicked
          FROM deliveries WHERE notification_id = $1 GROUP BY 1 ORDER BY 1`, [notificationId]),
    many(`SELECT COALESCE(s.country,'desconocido') AS label,
                 count(*)::bigint AS sent,
                 count(*) FILTER (WHERE d.clicked_at IS NOT NULL)::bigint AS clicked
          FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id
          WHERE d.notification_id = $1 GROUP BY 1 ORDER BY sent DESC LIMIT 20`, [notificationId]),
    many(`SELECT COALESCE(action_id,'principal') AS action, count(*)::bigint AS clicks
          FROM deliveries WHERE notification_id = $1 AND clicked_at IS NOT NULL
          GROUP BY 1 ORDER BY clicks DESC`, [notificationId]),
    many(`SELECT name, attribution, count(*)::bigint AS n, sum(value)::numeric AS total
          FROM outcome_attributions WHERE notification_id = $1 GROUP BY 1,2 ORDER BY n DESC`,
      [notificationId]),
    many(`SELECT error_code, count(*)::bigint AS n, max(error_message) AS sample
          FROM deliveries WHERE notification_id = $1 AND status = 'failed'
          GROUP BY 1 ORDER BY n DESC LIMIT 10`, [notificationId]),
  ]);

  const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
  const delivered = notification.received || statusMap.delivered || 0;
  return {
    notification,
    stats: {
      recipients: notification.recipients,
      sent: notification.successful,
      failed: notification.failed,
      delivered,
      clicked: notification.clicked,
      dismissed: notification.dismissed,
      converted: notification.converted,
      ctr: delivered > 0 ? Number((notification.clicked / delivered).toFixed(4)) : 0,
      delivery_rate: notification.successful > 0
        ? Number((delivered / notification.successful).toFixed(4)) : 0,
      by_status: statusMap,
    },
    hourly, by_variant: byVariant, by_country: byCountry,
    by_action: byAction, outcomes, errors,
  };
}

/** Serie temporal genérica de eventos (para gráficos personalizados). */
export async function eventSeries(appId, { type, name, from, to, bucket = 'day' }) {
  const buckets = { hour: 'hour', day: 'day', week: 'week', month: 'month' };
  const unit = buckets[bucket] || 'day';
  const params = [appId, from || new Date(Date.now() - 30 * 86400000), to || new Date()];
  let where = 'app_id = $1 AND created_at >= $2 AND created_at <= $3';
  if (type) { params.push(type); where += ` AND type = $${params.length}`; }
  if (name) { params.push(name); where += ` AND name = $${params.length}`; }
  return many(
    `SELECT date_trunc('${unit}', created_at) AS bucket, count(*)::bigint AS value,
            COALESCE(sum(value),0)::numeric AS total
     FROM events WHERE ${where} GROUP BY 1 ORDER BY 1`, params);
}

/** Crecimiento de la audiencia: altas y bajas por día. */
export async function growthSeries(appId, days = 30) {
  return many(
    `WITH d AS (SELECT generate_series(current_date - $2::int, current_date, '1 day')::date AS day)
     SELECT d.day,
            COALESCE(sum(ds.subs_added),0)::bigint AS added,
            COALESCE(sum(ds.subs_removed),0)::bigint AS removed
     FROM d LEFT JOIN daily_stats ds ON ds.day = d.day AND ds.app_id = $1
     GROUP BY d.day ORDER BY d.day`, [appId, days]);
}

/** Recalcula los agregados diarios de un día (tarea de mantenimiento). */
export async function rebuildDailyStats(appId, day) {
  const result = await query(
    `INSERT INTO daily_stats (app_id, day, channel, sent, delivered, clicked, dismissed, failed)
     SELECT $1, $2::date, channel,
            count(*) FILTER (WHERE sent_at IS NOT NULL),
            count(*) FILTER (WHERE delivered_at IS NOT NULL),
            count(*) FILTER (WHERE clicked_at IS NOT NULL),
            count(*) FILTER (WHERE dismissed_at IS NOT NULL),
            count(*) FILTER (WHERE status = 'failed')
     FROM deliveries
     WHERE app_id = $1 AND created_at >= $2::date AND created_at < $2::date + 1
     GROUP BY channel
     ON CONFLICT (app_id, day, channel) DO UPDATE SET
       sent = EXCLUDED.sent, delivered = EXCLUDED.delivered, clicked = EXCLUDED.clicked,
       dismissed = EXCLUDED.dismissed, failed = EXCLUDED.failed, updated_at = now()`,
    [appId, day]);
  logger.info('estadísticas diarias recalculadas', { appId, day, rows: result.rowCount });
  return result.rowCount;
}

export default {
  recordEvent, recordDeliveryStats, bumpDailyStats,
  trackDisplayed, trackClicked, trackDismissed, trackOutcome,
  appOverview, audienceBreakdown, notificationReport, eventSeries, growthSeries, rebuildDailyStats,
};
