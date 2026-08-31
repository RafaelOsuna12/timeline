/** API de analítica (`/api/v1/analytics`, `/api/v1/events`, exportaciones). */
import { many } from '../../db/index.js';
import { requireScope } from '../../plugins/auth.js';
import { badRequest } from '../../lib/errors.js';
import {
  appOverview, audienceBreakdown, eventSeries, growthSeries, trackOutcome,
} from '../../services/analytics.js';
import { createExport } from '../../services/exports.js';

export default async function analyticsRoutes(fastify) {
  const read = { preHandler: requireScope('analytics:read') };
  const write = { preHandler: requireScope('subscriptions:write') };

  /** Resumen general: audiencia, envíos, CTR y serie diaria. */
  fastify.get('/analytics/overview', read, async (request) =>
    appOverview(request.pushApp.id, Math.min(Number(request.query.days) || 30, 365)));

  /** Desglose de la audiencia por país, navegador, SO, idioma, dispositivo o canal. */
  fastify.get('/analytics/breakdown/:dimension', read, async (request) => ({
    dimension: request.params.dimension,
    data: await audienceBreakdown(request.pushApp.id, request.params.dimension,
      Math.min(Number(request.query.limit) || 20, 100)),
  }));

  /** Crecimiento de la audiencia (altas y bajas por día). */
  fastify.get('/analytics/growth', read, async (request) => ({
    series: await growthSeries(request.pushApp.id, Math.min(Number(request.query.days) || 30, 365)),
  }));

  /** Serie temporal de un tipo de evento. */
  fastify.get('/analytics/events', read, async (request) => ({
    series: await eventSeries(request.pushApp.id, {
      type: request.query.type,
      name: request.query.name,
      from: request.query.from ? new Date(request.query.from) : undefined,
      to: request.query.to ? new Date(request.query.to) : undefined,
      bucket: request.query.bucket || 'day',
    }),
  }));

  /** Rendimiento de outcomes con atribución directa / influenciada. */
  fastify.get('/analytics/outcomes', read, async (request) => ({
    outcomes: await many(
      `SELECT name, attribution, count(*)::bigint AS conversions, sum(value)::numeric AS total_value
       FROM outcome_attributions
       WHERE app_id = $1 AND created_at > now() - ($2 || ' days')::interval
       GROUP BY name, attribution ORDER BY conversions DESC`,
      [request.pushApp.id, Math.min(Number(request.query.days) || 30, 365)]),
  }));

  /** Ranking de notificaciones por CTR. */
  fastify.get('/analytics/top-notifications', read, async (request) => ({
    notifications: await many(
      `SELECT id, name, headings, contents, received, clicked, converted,
              CASE WHEN received > 0 THEN round(clicked::numeric / received, 4) ELSE 0 END AS ctr
       FROM notifications
       WHERE app_id = $1 AND status = 'sent' AND received > 0
         AND created_at > now() - ($2 || ' days')::interval
       ORDER BY ctr DESC, clicked DESC LIMIT 20`,
      [request.pushApp.id, Math.min(Number(request.query.days) || 30, 365)]),
  }));

  /** Registro de una conversión desde el backend del cliente. */
  fastify.post('/outcomes/record', write, async (request) => {
    const { name, value = 1, subscription_id, external_user_id, notification_id } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');

    let subscriptionId = subscription_id;
    if (!subscriptionId && external_user_id) {
      const rows = await many(
        `SELECT id FROM subscriptions WHERE app_id = $1 AND external_user_id = $2
         ORDER BY last_seen_at DESC LIMIT 1`, [request.pushApp.id, external_user_id]);
      subscriptionId = rows[0]?.id;
    }
    return trackOutcome({
      appId: request.pushApp.id, subscriptionId, name,
      value: Number(value) || 1, notificationId: notification_id || null,
    });
  });

  /** Exportación a CSV (se procesa en segundo plano). */
  fastify.post('/exports', read, async (request, reply) => {
    const { kind = 'subscriptions', ...params } = request.body || {};
    const job = await createExport(request.pushApp.id, kind, params);
    reply.code(202);
    return { export_id: job.id, status: job.status };
  });

  fastify.get('/exports/:id', read, async (request) => {
    const rows = await many('SELECT * FROM exports WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    return { export: rows[0] || null };
  });
}
