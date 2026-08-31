/**
 * Endpoints públicos que usan los SDK (web y Android).
 *
 * No requieren clave de API: se identifican con `app_id` y se protegen
 * validando el origen declarado en la app y con límite de peticiones por IP.
 */
import { one, many, query } from '../../db/index.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/validate.js';
import { absolutizar } from '../../lib/urls.js';
import { loadApp } from '../../plugins/auth.js';
import { upsertSubscription, updateSubscription, unsubscribe, trackSession }
  from '../../services/subscriptions.js';
import { trackDisplayed, trackClicked, trackDismissed, trackOutcome, recordEvent }
  from '../../services/analytics.js';
import { subscriptionMatches } from '../../services/audience.js';
import config from '../../config.js';

/** Comprueba que la petición procede de un origen autorizado de la app. */
function assertOrigin(request, app) {
  const origin = request.headers.origin;
  if (!origin) return;                       // apps nativas: no envían Origin
  const allowed = app.allowed_origins || [];
  if (allowed.length === 0) return;          // sin restricción configurada
  const normalized = origin.replace(/\/$/, '').toLowerCase();
  const ok = allowed.some((entry) => {
    const clean = String(entry).replace(/\/$/, '').toLowerCase();
    if (clean === '*') return true;
    if (clean.startsWith('*.')) return normalized.endsWith(clean.slice(1));
    return clean === normalized;
  });
  if (!ok) throw forbidden(`Origen no autorizado para esta app: ${origin}`);
}

async function appFrom(request, appId) {
  const id = appId || request.body?.app_id || request.query?.app_id;
  if (!id) throw badRequest('`app_id` es obligatorio');
  // Sin esta comprobación, un app_id mal copiado en el snippet llegaría a
  // PostgreSQL como uuid inválido y devolvería un 500 en vez de un aviso claro.
  if (!isUuid(id)) throw badRequest(`\`app_id\` no es un identificador válido: ${String(id).slice(0, 40)}`);
  const app = await loadApp(id);
  if (!app) throw notFound('App no encontrada');
  assertOrigin(request, app);
  return app;
}

/** Contexto del dispositivo derivado de la petición (IP, geo, idioma). */
function contextFrom(request) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    country: request.headers[config.geo.countryHeader] || null,
    city: request.headers[config.geo.cityHeader]
      ? decodeURIComponent(request.headers[config.geo.cityHeader]) : null,
    language: request.headers['accept-language']?.split(',')[0],
  };
}

export default async function publicRoutes(fastify) {
  /**
   * GET /sdk/v1/config — configuración pública que el SDK necesita para
   * arrancar: clave VAPID, textos del prompt y ajustes de comportamiento.
   */
  fastify.get('/sdk/v1/config', async (request, reply) => {
    const app = await appFrom(request);
    reply.header('cache-control', 'public, max-age=300');
    const settings = app.settings || {};
    return {
      app_id: app.id,
      name: app.name,
      vapid_public_key: app.vapid_public,
      api_url: config.server.publicUrl,
      default_icon: absolutizar(app.default_icon_url)
        || `${config.server.publicUrl}${config.brand.defaultIcon}`,
      safari_web_id: app.safari_web_id || null,
      prompt: settings.prompt || {
        type: 'slide',                       // slide | native | bell | manual
        delay_seconds: 5,
        page_views: 1,
        title: '¿Quieres recibir notificaciones?',
        message: 'Te avisaremos solo de lo importante. Puedes desactivarlo cuando quieras.',
        accept_text: 'Permitir',
        cancel_text: 'Ahora no',
        bell_position: 'bottom-right',
        remind_after_days: 7,
      },
      welcome_notification: settings.welcome_notification || null,
      service_worker_path: settings.service_worker_path || '/pushflow-sw.js',
      service_worker_scope: settings.service_worker_scope || '/',
      auto_resubscribe: settings.auto_resubscribe !== false,
      in_app_enabled: settings.in_app_enabled !== false,
    };
  });

  /** POST /sdk/v1/subscribe — alta del dispositivo desde el SDK. */
  fastify.post('/sdk/v1/subscribe', async (request, reply) => {
    const app = await appFrom(request);
    const { subscription, created } = await upsertSubscription(
      app.id, request.body || {}, contextFrom(request));
    reply.code(created ? 201 : 200);
    return {
      subscription_id: subscription.id,
      created,
      // El SDK dispara la notificación de bienvenida solo en el alta inicial.
      welcome: created ? (app.settings?.welcome_notification || null) : null,
    };
  });

  /** PATCH /sdk/v1/subscription/:id — tags, idioma, external_user_id. */
  fastify.patch('/sdk/v1/subscription/:id', async (request) => {
    const app = await appFrom(request);
    const subscription = await updateSubscription(app.id, request.params.id, request.body || {});
    return { subscription_id: subscription.id, tags: subscription.tags };
  });

  /**
   * POST /sdk/v1/subscription/:id/update — igual que el PATCH anterior.
   * Existe porque HttpURLConnection (Android) no admite el método PATCH.
   */
  fastify.post('/sdk/v1/subscription/:id/update', async (request) => {
    const app = await appFrom(request);
    const subscription = await updateSubscription(app.id, request.params.id, request.body || {});
    return { subscription_id: subscription.id, tags: subscription.tags };
  });

  /** DELETE /sdk/v1/subscription/:id — baja desde el propio sitio o app. */
  fastify.delete('/sdk/v1/subscription/:id', async (request) => {
    const app = await appFrom(request);
    await unsubscribe(app.id, request.params.id, 'sdk');
    return { unsubscribed: true };
  });

  /** POST /sdk/v1/session — inicio/fin de sesión (segmentación por actividad). */
  fastify.post('/sdk/v1/session', async (request) => {
    const app = await appFrom(request);
    const { subscription_id, duration = 0, start = true } = request.body || {};
    if (!subscription_id) throw badRequest('`subscription_id` es obligatorio');
    await trackSession(app.id, subscription_id, { durationSec: Number(duration) || 0, start: Boolean(start) });
    return { ok: true };
  });

  /**
   * POST /api/v1/events — tracking de la notificación.
   * Lo llama el service worker (web) y el SDK de Android.
   * Acepta `navigator.sendBeacon`, por lo que responde siempre 204 rápido.
   */
  fastify.post('/api/v1/events', async (request, reply) => {
    const body = request.body || {};
    const app = await appFrom(request);
    const common = {
      appId: app.id,
      notificationId: body.notification_id || body.i || null,
      subscriptionId: body.subscription_id || null,
      deliveryId: body.delivery_id || body.dl || null,
      meta: {
        url: body.url || null,
        country: request.headers[config.geo.countryHeader] || null,
        channel: body.channel || null,
      },
    };
    switch (body.type) {
      case 'displayed':
      case 'received':
        await trackDisplayed(common); break;
      case 'clicked':
        await trackClicked({ ...common, actionId: body.action_id || null, url: body.url }); break;
      case 'dismissed':
        await trackDismissed(common); break;
      case 'outcome':
        if (!body.name) throw badRequest('`name` es obligatorio para un outcome');
        await trackOutcome({
          appId: app.id, subscriptionId: common.subscriptionId,
          name: body.name, value: Number(body.value ?? 1),
          notificationId: common.notificationId,
        });
        break;
      default:
        await recordEvent(app.id, {
          type: body.type || 'custom', name: body.name || null,
          subscriptionId: common.subscriptionId, notificationId: common.notificationId,
          value: body.value ?? null, properties: body.properties || {}, url: body.url || null,
        });
    }
    reply.code(204);
    return null;
  });

  /**
   * GET /api/v1/click — redirección con tracking.
   * Útil cuando el clic debe registrarse aunque el service worker no esté activo.
   */
  fastify.get('/api/v1/click', async (request, reply) => {
    const { app_id, notification_id, subscription_id, delivery_id, action_id, url } = request.query;
    if (app_id && notification_id) {
      await trackClicked({
        appId: app_id, notificationId: notification_id, subscriptionId: subscription_id || null,
        deliveryId: delivery_id || null, actionId: action_id || null, url,
      }).catch(() => {});
    }
    if (url && /^https?:\/\//i.test(url)) return reply.redirect(url, 302);
    return reply.redirect(config.server.publicUrl, 302);
  });

  /** GET /sdk/v1/in-app — mensajes in-app que corresponde mostrar ahora. */
  fastify.get('/sdk/v1/in-app', async (request) => {
    const app = await appFrom(request);
    const subscriptionId = request.query.subscription_id;
    if (!subscriptionId) return { messages: [] };

    const candidates = await many(
      `SELECT m.* FROM in_app_messages m
       WHERE m.app_id = $1 AND m.status = 'active'
         AND (m.start_at IS NULL OR m.start_at <= now())
         AND (m.end_at IS NULL OR m.end_at >= now())
         AND COALESCE((SELECT displays FROM in_app_impressions i
                       WHERE i.message_id = m.id AND i.subscription_id = $2), 0) < m.max_displays
       ORDER BY m.created_at DESC LIMIT 10`, [app.id, subscriptionId]);

    const subscription = await one(
      'SELECT session_count, total_duration_sec FROM subscriptions WHERE id = $1', [subscriptionId]);
    const messages = [];
    for (const message of candidates) {
      if (message.filters?.length
          && !(await subscriptionMatches(app.id, subscriptionId, message.filters))) continue;
      const triggersOk = (message.triggers || []).every((trigger) => {
        const value = trigger.type === 'session_count' ? subscription?.session_count
          : trigger.type === 'session_time' ? subscription?.total_duration_sec : null;
        if (value == null) return true;
        const expected = Number(trigger.value);
        switch (trigger.operator) {
          case '>': return value > expected;
          case '>=': return value >= expected;
          case '<': return value < expected;
          case '=': default: return value === expected;
        }
      });
      if (triggersOk) messages.push({
        id: message.id, layout: message.layout, content: message.content,
      });
    }
    return { messages: messages.slice(0, 1) };   // uno cada vez, como OneSignal
  });

  /** POST /sdk/v1/in-app/:id/event — impresión o clic de un mensaje in-app. */
  fastify.post('/sdk/v1/in-app/:id/event', async (request, reply) => {
    const app = await appFrom(request);
    const { subscription_id, type = 'display' } = request.body || {};
    if (!subscription_id) throw badRequest('`subscription_id` es obligatorio');
    await query(
      `INSERT INTO in_app_impressions (message_id, subscription_id, displays, clicks, last_display_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (message_id, subscription_id) DO UPDATE SET
         displays = in_app_impressions.displays + EXCLUDED.displays,
         clicks = in_app_impressions.clicks + EXCLUDED.clicks,
         last_display_at = now()`,
      [request.params.id, subscription_id, type === 'display' ? 1 : 0, type === 'click' ? 1 : 0]);
    await recordEvent(app.id, {
      type: `in_app_${type}`, subscriptionId: subscription_id,
      properties: { message_id: request.params.id } });
    reply.code(204);
    return null;
  });
}
