/** API de automatizaciones, webhooks y mensajes in-app. */
import { one, many, query } from '../../db/index.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { requireScope } from '../../plugins/auth.js';
import { isValidCron } from '../../lib/cron.js';
import { randomToken } from '../../lib/crypto.js';
import { WEBHOOK_EVENTS } from '../../services/webhooks.js';

const TRIGGER_TYPES = ['subscription_created', 'event', 'tag_changed', 'inactivity', 'schedule'];

export default async function automationRoutes(fastify) {
  const write = { preHandler: requireScope('notifications:write') };
  const read = { preHandler: requireScope('analytics:read') };

  // --- Automatizaciones -----------------------------------------------------
  fastify.get('/automations', read, async (request) => ({
    automations: await many('SELECT * FROM automations WHERE app_id = $1 ORDER BY created_at DESC',
      [request.pushApp.id]),
  }));

  fastify.post('/automations', write, async (request, reply) => {
    const { name, trigger, steps = [], segment_id, status = 'paused', reentry = false } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');
    if (!trigger?.type || !TRIGGER_TYPES.includes(trigger.type)) {
      throw badRequest(`\`trigger.type\` debe ser uno de: ${TRIGGER_TYPES.join(', ')}`);
    }
    if (trigger.type === 'schedule' && !isValidCron(trigger.cron)) {
      throw badRequest('`trigger.cron` no es una expresión cron válida de 5 campos');
    }
    if (trigger.type === 'event' && !trigger.event_name) {
      throw badRequest('`trigger.event_name` es obligatorio para el trigger de tipo event');
    }
    if (!Array.isArray(steps) || steps.length === 0) throw badRequest('`steps` no puede estar vacío');
    for (const [index, step] of steps.entries()) {
      if (!['wait', 'send', 'condition', 'tag'].includes(step.type)) {
        throw badRequest(`Paso ${index}: tipo desconocido \`${step.type}\``);
      }
      if (step.type === 'send' && !step.payload) {
        throw badRequest(`Paso ${index}: un paso \`send\` necesita \`payload\``);
      }
    }
    const automation = await one(
      `INSERT INTO automations (app_id, name, trigger, steps, segment_id, status, reentry)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [request.pushApp.id, name, trigger, JSON.stringify(steps), segment_id || null, status, reentry]);
    reply.code(201);
    return { automation };
  });

  fastify.patch('/automations/:id', write, async (request) => {
    const { name, trigger, steps, status, segment_id, reentry } = request.body || {};
    if (status && !['active', 'paused', 'archived'].includes(status)) {
      throw badRequest('`status` debe ser active, paused o archived');
    }
    const automation = await one(
      `UPDATE automations SET name = COALESCE($3, name), trigger = COALESCE($4, trigger),
              steps = COALESCE($5, steps), status = COALESCE($6, status),
              segment_id = COALESCE($7, segment_id), reentry = COALESCE($8, reentry),
              updated_at = now()
       WHERE app_id = $1 AND id = $2 RETURNING *`,
      [request.pushApp.id, request.params.id, name || null, trigger || null,
       steps ? JSON.stringify(steps) : null, status || null, segment_id || null,
       reentry === undefined ? null : reentry]);
    if (!automation) throw notFound('Automatización no encontrada');
    return { automation };
  });

  fastify.delete('/automations/:id', write, async (request) => {
    const { rowCount } = await query('DELETE FROM automations WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Automatización no encontrada');
    return { deleted: true };
  });

  /** Recorridos activos de una automatización. */
  fastify.get('/automations/:id/runs', read, async (request) => ({
    runs: await many(
      `SELECT id, subscription_id, step_index, status, next_run_at, created_at
       FROM automation_runs WHERE automation_id = $1 AND app_id = $2
       ORDER BY created_at DESC LIMIT 100`, [request.params.id, request.pushApp.id]),
  }));

  /**
   * POST /events/track — dispara automatizaciones desde el backend del cliente
   * (por ejemplo "carrito_abandonado").
   */
  fastify.post('/events/track', write, async (request) => {
    const { event_name, subscription_id, external_user_id, properties = {} } = request.body || {};
    if (!event_name) throw badRequest('`event_name` es obligatorio');

    let subscriptionIds = subscription_id ? [subscription_id] : [];
    if (!subscriptionIds.length && external_user_id) {
      const rows = await many(
        `SELECT id FROM subscriptions WHERE app_id = $1 AND external_user_id = $2 AND subscribed`,
        [request.pushApp.id, external_user_id]);
      subscriptionIds = rows.map((r) => r.id);
    }
    if (!subscriptionIds.length) throw badRequest('No se encontró ninguna suscripción de destino');

    const { recordEvent } = await import('../../services/analytics.js');
    const { enqueue } = await import('../../services/queue.js');
    for (const id of subscriptionIds) {
      await recordEvent(request.pushApp.id, {
        type: 'custom', name: event_name, subscriptionId: id, properties });
      await enqueue('automation.trigger', {
        appId: request.pushApp.id, event: 'event', eventName: event_name, subscriptionId: id,
      }, { appId: request.pushApp.id, priority: 80 });
    }
    return { triggered: subscriptionIds.length };
  });

  // --- Webhooks -------------------------------------------------------------
  fastify.get('/webhooks', read, async (request) => ({
    webhooks: await many('SELECT id, url, events, active, created_at FROM webhooks WHERE app_id = $1',
      [request.pushApp.id]),
    available_events: WEBHOOK_EVENTS,
  }));

  fastify.post('/webhooks', write, async (request, reply) => {
    const { url, events = ['notification.sent'] } = request.body || {};
    if (!url || !/^https?:\/\//i.test(url)) throw badRequest('`url` debe ser una URL http(s)');
    for (const event of events) {
      if (!WEBHOOK_EVENTS.includes(event)) throw badRequest(`Evento desconocido: ${event}`);
    }
    const secret = randomToken(24);
    const webhook = await one(
      `INSERT INTO webhooks (app_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING *`,
      [request.pushApp.id, url, events, secret]);
    reply.code(201);
    return { webhook };   // el `secret` solo se muestra al crearlo
  });

  fastify.delete('/webhooks/:id', write, async (request) => {
    const { rowCount } = await query('DELETE FROM webhooks WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Webhook no encontrado');
    return { deleted: true };
  });

  // --- Mensajes in-app ------------------------------------------------------
  fastify.get('/in-app-messages', read, async (request) => ({
    messages: await many('SELECT * FROM in_app_messages WHERE app_id = $1 ORDER BY created_at DESC',
      [request.pushApp.id]),
  }));

  fastify.post('/in-app-messages', write, async (request, reply) => {
    const { name, layout = 'modal', content = {}, triggers = [], filters = [],
            max_displays = 1, start_at, end_at, status = 'draft' } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');
    if (!content.body && !content.title) throw badRequest('`content.title` o `content.body` es obligatorio');
    const message = await one(
      `INSERT INTO in_app_messages (app_id, name, layout, content, triggers, filters,
                                    max_displays, start_at, end_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [request.pushApp.id, name, layout, content, JSON.stringify(triggers), JSON.stringify(filters),
       Number(max_displays), start_at || null, end_at || null, status]);
    reply.code(201);
    return { message };
  });

  fastify.patch('/in-app-messages/:id', write, async (request) => {
    const { status, content, triggers, max_displays } = request.body || {};
    const message = await one(
      `UPDATE in_app_messages SET status = COALESCE($3, status), content = COALESCE($4, content),
              triggers = COALESCE($5, triggers), max_displays = COALESCE($6, max_displays),
              updated_at = now()
       WHERE app_id = $1 AND id = $2 RETURNING *`,
      [request.pushApp.id, request.params.id, status || null, content || null,
       triggers ? JSON.stringify(triggers) : null, max_displays || null]);
    if (!message) throw notFound('Mensaje in-app no encontrado');
    return { message };
  });

  fastify.delete('/in-app-messages/:id', write, async (request) => {
    const { rowCount } = await query('DELETE FROM in_app_messages WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Mensaje in-app no encontrado');
    return { deleted: true };
  });
}
