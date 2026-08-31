/**
 * API REST de suscripciones (`/api/v1/subscriptions`).
 * Se mantienen alias en `/players` para clientes que ya usan la API de OneSignal.
 */
import { one, many, query } from '../../db/index.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { requireScope } from '../../plugins/auth.js';
import {
  upsertSubscription, updateSubscription, unsubscribe, listSubscriptions, tagByExternalId,
} from '../../services/subscriptions.js';

export default async function subscriptionRoutes(fastify) {
  const write = { preHandler: requireScope('subscriptions:write') };
  const read = { preHandler: requireScope('analytics:read') };

  /** POST /subscriptions — alta o actualización de un dispositivo. */
  fastify.post('/subscriptions', write, async (request, reply) => {
    const { subscription, created } = await upsertSubscription(
      request.pushApp.id, request.body || {}, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        country: request.geo?.country,
        city: request.geo?.city,
        language: request.headers['accept-language']?.split(',')[0],
      });
    reply.code(created ? 201 : 200);
    return { id: subscription.id, subscription_id: subscription.id, created };
  });

  /** GET /subscriptions — listado con filtros. */
  fastify.get('/subscriptions', read, async (request) => {
    const { limit, offset, search, channel, status } = request.query;
    return listSubscriptions(request.pushApp.id, {
      limit: Number(limit) || 50, offset: Number(offset) || 0, search, channel, status,
    });
  });

  /** GET /subscriptions/:id — ficha completa con su historial reciente. */
  fastify.get('/subscriptions/:id', read, async (request) => {
    const subscription = await one('SELECT * FROM subscriptions WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!subscription) throw notFound('Suscripción no encontrada');
    const history = await many(
      `SELECT d.notification_id, d.status, d.sent_at, d.clicked_at, n.headings, n.contents
       FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.subscription_id = $1 ORDER BY d.created_at DESC LIMIT 25`, [request.params.id]);
    delete subscription.p256dh;
    delete subscription.auth_key;
    return { subscription, history };
  });

  /** PATCH /subscriptions/:id — tags, idioma, external_user_id, estado. */
  fastify.patch('/subscriptions/:id', write, async (request) =>
    ({ subscription: await updateSubscription(request.pushApp.id, request.params.id, request.body || {}) }));

  /** DELETE /subscriptions/:id — baja (conserva la fila para la analítica). */
  fastify.delete('/subscriptions/:id', write, async (request) => {
    const row = await unsubscribe(request.pushApp.id, request.params.id, 'api');
    if (!row) throw notFound('Suscripción no encontrada');
    return { unsubscribed: true };
  });

  /** PUT /users/:externalId/tags — etiqueta todos los dispositivos de un usuario. */
  fastify.put('/users/:externalId/tags', write, async (request) => {
    const updated = await tagByExternalId(
      request.pushApp.id, request.params.externalId, request.body?.tags || request.body || {});
    return { updated_subscriptions: updated };
  });

  /** GET /users/:externalId — todos los dispositivos de un usuario final. */
  fastify.get('/users/:externalId', read, async (request) => {
    const user = await one('SELECT * FROM end_users WHERE app_id = $1 AND external_id = $2',
      [request.pushApp.id, request.params.externalId]);
    const subscriptions = await many(
      `SELECT id, channel, device_type, country, language, subscribed, invalid, tags, last_seen_at
       FROM subscriptions WHERE app_id = $1 AND external_user_id = $2`,
      [request.pushApp.id, request.params.externalId]);
    if (!user && subscriptions.length === 0) throw notFound('Usuario no encontrado');
    return { user, subscriptions };
  });

  /** DELETE /users/:externalId — borrado completo (derecho de supresión, RGPD). */
  fastify.delete('/users/:externalId', write, async (request) => {
    const { rowCount } = await query(
      'DELETE FROM subscriptions WHERE app_id = $1 AND external_user_id = $2',
      [request.pushApp.id, request.params.externalId]);
    await query('DELETE FROM end_users WHERE app_id = $1 AND external_id = $2',
      [request.pushApp.id, request.params.externalId]);
    return { deleted_subscriptions: rowCount };
  });

  /** POST /subscriptions/bulk-tag — etiquetado masivo por filtros. */
  fastify.post('/subscriptions/bulk-tag', write, async (request) => {
    const { filters, tags } = request.body || {};
    if (!tags || typeof tags !== 'object') throw badRequest('`tags` es obligatorio');
    const { buildAudienceQuery } = await import('../../services/audience.js');
    const audience = await buildAudienceQuery(request.pushApp.id,
      { targetType: filters?.length ? 'filters' : 'all', filters: filters || [] },
      { columns: 's.id' });
    const { rowCount } = await query(
      `UPDATE subscriptions SET tags = tags || $${audience.values.length + 1}::jsonb, updated_at = now()
       WHERE id IN (${audience.sql})`,
      [...audience.values, JSON.stringify(tags)]);
    return { updated: rowCount };
  });

  // --- Alias compatibles con OneSignal --------------------------------------
  fastify.post('/players', write, async (request, reply) => {
    const { subscription, created } = await upsertSubscription(
      request.pushApp.id, request.body || {},
      { ip: request.ip, userAgent: request.headers['user-agent'] });
    reply.code(created ? 201 : 200);
    return { success: true, id: subscription.id };
  });

  fastify.put('/players/:id', write, async (request) => {
    await updateSubscription(request.pushApp.id, request.params.id, request.body || {});
    return { success: true };
  });
}
