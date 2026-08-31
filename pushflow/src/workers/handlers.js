/** Registro de manejadores de trabajos de la cola. */
import { dispatchNotification, sendBatch, finalizeNotification } from '../services/dispatcher.js';
import { deliverWebhook } from '../services/webhooks.js';
import { handleTrigger } from '../services/automation.js';
import { runExport } from '../services/exports.js';
import { rebuildDailyStats } from '../services/analytics.js';
import { purgeInvalid } from '../services/subscriptions.js';
import { purgeCompleted } from '../services/queue.js';
import { query, many } from '../db/index.js';
import config from '../config.js';
import logger from '../lib/logger.js';

export const handlers = {
  'notification.dispatch': ({ notificationId }) => dispatchNotification(notificationId),
  'notification.batch': (payload) => sendBatch(payload),
  'notification.finalize': (payload) => finalizeNotification(payload),
  'webhook.deliver': (payload) => deliverWebhook(payload),
  'automation.trigger': (payload) => handleTrigger(payload),
  'export.run': ({ exportId }) => runExport(exportId),

  /** Notificación de bienvenida tras el alta de un dispositivo. */
  'subscription.welcome': async ({ appId, subscriptionId }) => {
    const { one: findOne } = await import('../db/index.js');
    const app = await findOne('SELECT * FROM apps WHERE id = $1', [appId]);
    const welcome = app?.settings?.welcome_notification;
    if (!welcome?.enabled) return { skipped: true };

    const subscription = await findOne(
      'SELECT id FROM subscriptions WHERE id = $1 AND subscribed AND NOT invalid', [subscriptionId]);
    if (!subscription) return { skipped: true };

    const { createNotification } = await import('../services/notifications.js');
    const result = await createNotification(app, {
      headings: welcome.title || welcome.headings || { es: `¡Bienvenido a ${app.name}!` },
      contents: welcome.message || welcome.contents || { es: 'Gracias por suscribirte.' },
      url: welcome.url || app.site_url,
      icon_url: welcome.icon_url || app.default_icon_url,
      image_url: welcome.image_url,
      include_subscription_ids: [subscriptionId],
      name: 'bienvenida',
      respect_frequency_cap: false,
    }, { source: 'welcome' });
    return { notificationId: result.notification.id };
  },

  /** Mantenimiento diario: particiones, retención y agregados. */
  'maintenance.daily': async () => {
    await query('SELECT pushflow_ensure_partitions(3)');
    const dropped = await query('SELECT pushflow_drop_old_partitions($1) AS n',
      [config.retention.eventsMonths]);
    const jobs = await purgeCompleted(config.retention.jobsDays);

    await query(`DELETE FROM admin_sessions WHERE expires_at < now()`);
    await query(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days'`);

    const apps = await many(`SELECT id FROM apps WHERE status = 'active'`);
    for (const app of apps) {
      await rebuildDailyStats(app.id, new Date(Date.now() - 86400000).toISOString().slice(0, 10));
      await purgeInvalid(app.id, 180);
    }
    logger.info('mantenimiento diario completado', {
      partitionsDropped: dropped.rows[0]?.n || 0, jobsPurged: jobs, apps: apps.length });
    return { ok: true };
  },

  /** Recuento periódico de los segmentos (para mostrarlo en el panel). */
  'segments.refresh': async () => {
    const { countSegment } = await import('../services/audience.js');
    const segments = await many('SELECT id, app_id FROM segments');
    for (const segment of segments) {
      try {
        const count = await countSegment(segment.app_id, segment.id);
        await query('UPDATE segments SET cached_count = $2, cached_at = now() WHERE id = $1',
          [segment.id, count]);
      } catch (err) {
        logger.warn('no se pudo contar el segmento', { segmentId: segment.id, error: err.message });
      }
    }
    return { segments: segments.length };
  },
};

export default handlers;
