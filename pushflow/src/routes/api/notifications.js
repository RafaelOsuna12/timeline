/** API REST de notificaciones (`/api/v1/notifications`). */
import { one, many } from '../../db/index.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { requireScope } from '../../plugins/auth.js';
import {
  createNotification, cancelNotification, listNotifications,
} from '../../services/notifications.js';
import { notificationReport } from '../../services/analytics.js';
import { countAudience } from '../../services/audience.js';

export default async function notificationRoutes(fastify) {
  const write = { preHandler: requireScope('notifications:write') };
  const read = { preHandler: requireScope('analytics:read') };

  /**
   * POST /notifications — crea y envía (o programa) una notificación.
   * Acepta el mismo cuerpo que la API de OneSignal.
   */
  fastify.post('/notifications', write, async (request, reply) => {
    const result = await createNotification(request.pushApp, request.body || {}, { source: 'api' });
    if (result.dry_run) return result;
    reply.code(result.deduplicated ? 200 : 201);
    return {
      id: result.notification.id,
      status: result.notification.status,
      recipients: result.notification.recipients,
      deduplicated: result.deduplicated || false,
    };
  });

  /** POST /notifications/estimate — cuántos dispositivos recibiría, sin enviar. */
  fastify.post('/notifications/estimate', read, async (request) => {
    const body = request.body || {};
    const recipients = await countAudience(request.pushApp.id, {
      targetType: body.included_segments?.length ? 'segments'
        : body.filters?.length ? 'filters'
        : body.include_subscription_ids?.length ? 'subscription_ids'
        : body.include_external_user_ids?.length ? 'external_ids' : 'all',
      includedSegments: body.included_segments || [],
      excludedSegments: body.excluded_segments || [],
      filters: body.filters || [],
      includeSubscriptionIds: body.include_subscription_ids || [],
      includeExternalIds: body.include_external_user_ids || [],
      channels: body.channels || null,
    });
    return { estimated_recipients: recipients };
  });

  /** GET /notifications — historial paginado. */
  fastify.get('/notifications', read, async (request) => {
    const { limit, offset, status } = request.query;
    return listNotifications(request.pushApp.id, {
      limit: Number(limit) || 30, offset: Number(offset) || 0, status,
    });
  });

  /** GET /notifications/:id — detalle con métricas completas. */
  fastify.get('/notifications/:id', read, async (request) => {
    const notification = await one('SELECT id FROM notifications WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!notification) throw notFound('Notificación no encontrada');
    return notificationReport(request.params.id);
  });

  /** GET /notifications/:id/deliveries — entregas individuales (auditoría). */
  fastify.get('/notifications/:id/deliveries', read, async (request) => {
    const { limit = 100, offset = 0, status } = request.query;
    const values = [request.pushApp.id, request.params.id];
    let where = 'app_id = $1 AND notification_id = $2';
    if (status) { values.push(status); where += ` AND status = $${values.length}`; }
    values.push(Math.min(Number(limit), 1000), Number(offset));
    const rows = await many(
      `SELECT id, subscription_id, channel, variant, status, error_code, error_message,
              sent_at, delivered_at, clicked_at, dismissed_at, action_id
       FROM deliveries WHERE ${where}
       ORDER BY id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { deliveries: rows };
  });

  /** DELETE /notifications/:id — cancela una programada o en curso. */
  fastify.delete('/notifications/:id', write, async (request) =>
    cancelNotification(request.pushApp.id, request.params.id));

  /**
   * POST /notifications/:id/winner — cierra un test A/B enviando la variante
   * ganadora al resto de la audiencia.
   */
  fastify.post('/notifications/:id/winner', write, async (request) => {
    const notification = await one('SELECT * FROM notifications WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!notification) throw notFound('Notificación no encontrada');
    if (!notification.ab_test?.variants?.length) throw badRequest('Esta notificación no es un test A/B');

    const variantId = request.body?.variant_id
      || (await one(
        `SELECT variant FROM deliveries WHERE notification_id = $1 AND variant IS NOT NULL
         GROUP BY variant
         ORDER BY count(*) FILTER (WHERE clicked_at IS NOT NULL)::numeric
                  / GREATEST(count(*) FILTER (WHERE delivered_at IS NOT NULL), 1) DESC
         LIMIT 1`, [notification.id]))?.variant;
    if (!variantId) throw badRequest('Todavía no hay datos suficientes para elegir una ganadora');

    const winner = notification.ab_test.variants.find((v) => String(v.id) === String(variantId));
    if (!winner) throw badRequest(`La variante ${variantId} no existe`);

    const result = await createNotification(request.pushApp, {
      ...request.body?.overrides,
      headings: winner.headings, contents: winner.contents,
      url: winner.url || notification.url,
      image_url: winner.image_url || notification.image_url,
      icon_url: notification.icon_url,
      buttons: notification.buttons,
      channels: notification.channels,
      included_segments: notification.included_segments,
      filters: notification.filters,
      excluded_segments: notification.excluded_segments,
      name: `${notification.name || 'A/B'} — ganadora ${variantId}`,
    }, { source: 'ab_winner' });

    return { winner: variantId, notification_id: result.notification.id };
  });
}
