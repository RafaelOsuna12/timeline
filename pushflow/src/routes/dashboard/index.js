/**
 * Panel de administración: sesión, gestión de apps y datos para la interfaz.
 * Todo cuelga de `/admin/api`. La interfaz estática se sirve desde /public.
 */
import { one, many, query, Params } from '../../db/index.js';
import { badRequest, unauthorized, notFound, conflict } from '../../lib/errors.js';
import {
  hashPassword, verifyPassword, randomToken, sha256, generateApiKey, encryptSecret,
} from '../../lib/crypto.js';
import config from '../../config.js';
import {
  requireAdmin, requireRole, loadAdminApp, invalidateAppCache,
} from '../../plugins/auth.js';
import { generateVapidKeys } from '../../services/channels/webpush.js';
import { verifyCredentials, clearTokenCache } from '../../services/channels/fcm.js';
import { appOverview, audienceBreakdown, notificationReport, growthSeries } from '../../services/analytics.js';
import { listSubscriptions } from '../../services/subscriptions.js';
import {
  listNotifications, createNotification, cancelNotification, sendAbWinner,
} from '../../services/notifications.js';
import { countAudience, countSegment, buildFilterSql } from '../../services/audience.js';
import { isValidCron } from '../../lib/cron.js';
import { stats as queueStats } from '../../services/queue.js';
import logger from '../../lib/logger.js';

const SESSION_COOKIE = 'pf_session';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.server.publicUrl.startsWith('https://'),
    path: '/',
    maxAge: config.security.sessionTtlHours * 3600,
  };
}

/** Segmentos por defecto que se crean con cada app nueva. */
const DEFAULT_SEGMENTS = [
  { name: 'Todos los suscriptores', filters: [], is_system: true },
  { name: 'Suscriptores activos (30 días)',
    filters: [{ field: 'last_session', relation: '<', hours_ago: 720 }] },
  { name: 'Inactivos (más de 30 días)',
    filters: [{ field: 'last_session', relation: '>', hours_ago: 720 }] },
  { name: 'Nuevos (últimas 24 h)',
    filters: [{ field: 'first_session', relation: '<', hours_ago: 24 }] },
  { name: 'Solo web', filters: [{ field: 'channel', relation: '=', value: 'web_push' }] },
  { name: 'Solo Android', filters: [{ field: 'channel', relation: '=', value: 'android' }] },
  { name: 'Usuarios de prueba', filters: [{ field: 'test_type', relation: '=', value: 2 }] },
];

export default async function dashboardRoutes(fastify) {
  const auth = { preHandler: requireAdmin };
  const appScope = { preHandler: loadAdminApp };
  const editor = { preHandler: [loadAdminApp, requireRole('owner', 'admin', 'member')] };

  // -------------------------------------------------------------------------
  // Sesión
  // -------------------------------------------------------------------------
  fastify.post('/admin/api/login', async (request, reply) => {
    const { email, password } = request.body || {};
    if (!email || !password) throw badRequest('Email y contraseña son obligatorios');

    const user = await one(
      `SELECT * FROM admin_users WHERE lower(email) = lower($1) AND status = 'active'`, [email]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      logger.warn('intento de acceso fallido', { email, ip: request.ip });
      throw unauthorized('Email o contraseña incorrectos');
    }

    const token = randomToken(32);
    await one(
      `INSERT INTO admin_sessions (user_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval) RETURNING id`,
      [user.id, sha256(token), request.ip, request.headers['user-agent'] || null,
       config.security.sessionTtlHours]);
    await query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);

    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  fastify.post('/admin/api/logout', async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  fastify.get('/admin/api/me', auth, async (request) => ({
    user: {
      id: request.admin.user_id, email: request.admin.email,
      name: request.admin.name, role: request.admin.role,
    },
  }));

  fastify.post('/admin/api/password', auth, async (request) => {
    const { current_password, new_password } = request.body || {};
    if (!new_password || new_password.length < 10) {
      throw badRequest('La nueva contraseña debe tener al menos 10 caracteres');
    }
    const user = await one('SELECT password_hash FROM admin_users WHERE id = $1',
      [request.admin.user_id]);
    if (!verifyPassword(current_password || '', user.password_hash)) {
      throw unauthorized('La contraseña actual no es correcta');
    }
    await query('UPDATE admin_users SET password_hash = $2, updated_at = now() WHERE id = $1',
      [request.admin.user_id, hashPassword(new_password)]);
    await query('DELETE FROM admin_sessions WHERE user_id = $1', [request.admin.user_id]);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Equipo
  // -------------------------------------------------------------------------
  fastify.get('/admin/api/team', auth, async (request) => ({
    members: await many(
      `SELECT id, email, name, role, status, last_login_at, created_at
       FROM admin_users WHERE org_id = $1 ORDER BY created_at`, [request.admin.org_id]),
  }));

  fastify.post('/admin/api/team', { preHandler: requireRole('owner', 'admin') }, async (request, reply) => {
    const { email, name, password, role = 'member' } = request.body || {};
    if (!email || !password) throw badRequest('Email y contraseña son obligatorios');
    if (password.length < 10) throw badRequest('La contraseña debe tener al menos 10 caracteres');
    if (!['admin', 'member', 'viewer'].includes(role)) throw badRequest('Rol no válido');
    const exists = await one('SELECT id FROM admin_users WHERE lower(email) = lower($1)', [email]);
    if (exists) throw conflict('Ya existe un usuario con ese email');
    const user = await one(
      `INSERT INTO admin_users (org_id, email, name, password_hash, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, created_at`,
      [request.admin.org_id, email, name || null, hashPassword(password), role]);
    reply.code(201);
    return { user };
  });

  fastify.delete('/admin/api/team/:id', { preHandler: requireRole('owner', 'admin') }, async (request) => {
    if (request.params.id === request.admin.user_id) throw badRequest('No puedes eliminarte a ti mismo');
    const { rowCount } = await query('DELETE FROM admin_users WHERE id = $1 AND org_id = $2',
      [request.params.id, request.admin.org_id]);
    if (!rowCount) throw notFound('Usuario no encontrado');
    return { deleted: true };
  });

  // -------------------------------------------------------------------------
  // Apps
  // -------------------------------------------------------------------------
  fastify.get('/admin/api/apps', auth, async (request) => ({
    apps: await many(
      `SELECT a.id, a.name, a.slug, a.site_url, a.status, a.created_at,
              a.vapid_public IS NOT NULL AS web_ready,
              a.fcm_project_id IS NOT NULL AS android_ready,
              (SELECT count(*) FROM subscriptions s
               WHERE s.app_id = a.id AND s.subscribed AND NOT s.invalid)::bigint AS subscribers
       FROM apps a WHERE a.org_id = $1 AND a.status <> 'archived' ORDER BY a.created_at`,
      [request.admin.org_id]),
  }));

  /** Crea una app: genera claves VAPID, una clave de API y los segmentos base. */
  fastify.post('/admin/api/apps', { preHandler: requireRole('owner', 'admin') }, async (request, reply) => {
    const { name, site_url, allowed_origins, default_icon_url } = request.body || {};
    if (!name) throw badRequest('`name` es obligatorio');

    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
      || `app-${Date.now()}`;
    const vapid = generateVapidKeys();
    const origins = Array.isArray(allowed_origins) ? allowed_origins
      : site_url ? [new URL(site_url).origin] : [];

    const app = await one(
      `INSERT INTO apps (org_id, name, slug, site_url, allowed_origins, default_icon_url,
                         vapid_public, vapid_private, vapid_subject, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [request.admin.org_id, name, slug, site_url || null, origins, default_icon_url || null,
       vapid.publicKey, vapid.privateKey,
       site_url ? `mailto:admin@${new URL(site_url).hostname}` : config.push.vapidSubject,
       { prompt: { type: 'slide', delay_seconds: 5 },
         quiet_hours: { enabled: false, start: '22:00', end: '08:00' },
         frequency_cap: { enabled: false, max_per_day: 3 } }]);

    for (const segment of DEFAULT_SEGMENTS) {
      await query(
        `INSERT INTO segments (app_id, name, filters, is_system) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [app.id, segment.name, JSON.stringify(segment.filters), segment.is_system || false]);
    }

    const apiKey = generateApiKey();
    await query(
      `INSERT INTO api_keys (app_id, name, key_prefix, key_hash, scopes)
       VALUES ($1,'principal',$2,$3,$4)`,
      [app.id, apiKey.prefix, apiKey.hash,
       ['notifications:write', 'subscriptions:write', 'analytics:read']]);

    logger.info('app creada', { appId: app.id, name });
    reply.code(201);
    return {
      app: { ...app, vapid_private: undefined, fcm_private_key: undefined },
      api_key: apiKey.key,       // se muestra una única vez
    };
  });

  fastify.get('/admin/api/apps/:appId', appScope, async (request) => {
    const app = { ...request.pushApp };
    delete app.vapid_private;
    app.fcm_configured = Boolean(app.fcm_private_key);
    delete app.fcm_private_key;
    return {
      app,
      snippet_url: `${config.server.publicUrl}/sdk/v1/push.js`,
      service_worker_url: `${config.server.publicUrl}/pushflow-sw.js`,
    };
  });

  fastify.patch('/admin/api/apps/:appId', editor, async (request) => {
    const { name, site_url, allowed_origins, default_icon_url, settings, status } = request.body || {};
    const app = await one(
      `UPDATE apps SET name = COALESCE($2, name), site_url = COALESCE($3, site_url),
              allowed_origins = COALESCE($4, allowed_origins),
              default_icon_url = COALESCE($5, default_icon_url),
              settings = COALESCE($6, settings), status = COALESCE($7, status), updated_at = now()
       WHERE id = $1 RETURNING id, name, site_url, allowed_origins, default_icon_url, settings, status`,
      [request.pushApp.id, name || null, site_url || null,
       allowed_origins || null, default_icon_url || null, settings || null, status || null]);
    invalidateAppCache(request.pushApp.id);
    return { app };
  });

  /** Regenera las claves VAPID (invalida todas las suscripciones web). */
  fastify.post('/admin/api/apps/:appId/vapid/rotate', editor, async (request) => {
    const vapid = generateVapidKeys();
    await query('UPDATE apps SET vapid_public=$2, vapid_private=$3, updated_at=now() WHERE id=$1',
      [request.pushApp.id, vapid.publicKey, vapid.privateKey]);
    await query(
      `UPDATE subscriptions SET invalid = true, invalid_reason = 'vapid_rotated', invalidated_at = now()
       WHERE app_id = $1 AND channel = 'web_push'`, [request.pushApp.id]);
    invalidateAppCache(request.pushApp.id);
    logger.warn('claves VAPID rotadas', { appId: request.pushApp.id });
    return { vapid_public_key: vapid.publicKey,
             warning: 'Las suscripciones web existentes deberán volver a registrarse.' };
  });

  /** Guarda las credenciales de FCM (JSON de la cuenta de servicio). */
  fastify.post('/admin/api/apps/:appId/fcm', editor, async (request) => {
    const body = request.body || {};
    const credentials = body.service_account_json
      ? (typeof body.service_account_json === 'string'
          ? JSON.parse(body.service_account_json) : body.service_account_json)
      : body;
    const projectId = credentials.project_id || body.fcm_project_id;
    const clientEmail = credentials.client_email || body.fcm_client_email;
    const privateKey = credentials.private_key || body.fcm_private_key;
    if (!projectId || !clientEmail || !privateKey) {
      throw badRequest('El JSON debe incluir project_id, client_email y private_key');
    }

    const check = await verifyCredentials({
      fcm_project_id: projectId, fcm_client_email: clientEmail,
      fcm_private_key: encryptSecret(privateKey),
    });
    if (!check.ok) throw badRequest(`Google rechazó las credenciales: ${check.error}`);

    await query(
      `UPDATE apps SET fcm_project_id=$2, fcm_client_email=$3, fcm_private_key=$4,
              android_package = COALESCE($5, android_package), updated_at=now()
       WHERE id=$1`,
      [request.pushApp.id, projectId, clientEmail, encryptSecret(privateKey),
       body.android_package || null]);
    clearTokenCache(request.pushApp.id);
    invalidateAppCache(request.pushApp.id);
    return { ok: true, project_id: projectId };
  });

  // -------------------------------------------------------------------------
  // Claves de API
  // -------------------------------------------------------------------------
  fastify.get('/admin/api/apps/:appId/keys', appScope, async (request) => ({
    keys: await many(
      `SELECT id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
       FROM api_keys WHERE app_id = $1 ORDER BY created_at DESC`, [request.pushApp.id]),
  }));

  fastify.post('/admin/api/apps/:appId/keys', editor, async (request, reply) => {
    const { name = 'nueva', scopes } = request.body || {};
    const apiKey = generateApiKey();
    const row = await one(
      `INSERT INTO api_keys (app_id, name, key_prefix, key_hash, scopes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, key_prefix, scopes, created_at`,
      [request.pushApp.id, name, apiKey.prefix, apiKey.hash,
       scopes || ['notifications:write', 'subscriptions:write', 'analytics:read']]);
    reply.code(201);
    return { key: row, api_key: apiKey.key };
  });

  fastify.delete('/admin/api/apps/:appId/keys/:keyId', editor, async (request) => {
    const { rowCount } = await query(
      'UPDATE api_keys SET revoked_at = now() WHERE app_id = $1 AND id = $2 AND revoked_at IS NULL',
      [request.pushApp.id, request.params.keyId]);
    if (!rowCount) throw notFound('Clave no encontrada');
    return { revoked: true };
  });

  // -------------------------------------------------------------------------
  // Datos para la interfaz
  // -------------------------------------------------------------------------
  fastify.get('/admin/api/apps/:appId/overview', appScope, async (request) =>
    appOverview(request.pushApp.id, Math.min(Number(request.query.days) || 30, 365)));

  fastify.get('/admin/api/apps/:appId/growth', appScope, async (request) => ({
    series: await growthSeries(request.pushApp.id, Math.min(Number(request.query.days) || 30, 365)),
  }));

  fastify.get('/admin/api/apps/:appId/breakdown/:dimension', appScope, async (request) => ({
    data: await audienceBreakdown(request.pushApp.id, request.params.dimension, 15),
  }));

  fastify.get('/admin/api/apps/:appId/subscriptions', appScope, async (request) =>
    listSubscriptions(request.pushApp.id, {
      limit: Number(request.query.limit) || 50,
      offset: Number(request.query.offset) || 0,
      search: request.query.search,
      channel: request.query.channel,
      status: request.query.status,
    }));

  fastify.get('/admin/api/apps/:appId/notifications', appScope, async (request) =>
    listNotifications(request.pushApp.id, {
      limit: Number(request.query.limit) || 30,
      offset: Number(request.query.offset) || 0,
      status: request.query.status,
    }));

  fastify.get('/admin/api/apps/:appId/notifications/:id', appScope, async (request) => {
    const report = await notificationReport(request.params.id);
    if (!report || report.notification.app_id !== request.pushApp.id) {
      throw notFound('Notificación no encontrada');
    }
    return report;
  });

  fastify.post('/admin/api/apps/:appId/notifications', editor, async (request, reply) => {
    const result = await createNotification(request.pushApp, request.body || {},
      { createdBy: request.admin.user_id, source: 'dashboard' });
    if (result.dry_run) return result;
    reply.code(201);
    return { notification: result.notification };
  });

  fastify.delete('/admin/api/apps/:appId/notifications/:id', editor, async (request) =>
    cancelNotification(request.pushApp.id, request.params.id));

  fastify.post('/admin/api/apps/:appId/estimate', appScope, async (request) => {
    const body = request.body || {};
    return {
      estimated_recipients: await countAudience(request.pushApp.id, {
        targetType: body.target_type || 'all',
        includedSegments: body.included_segments || [],
        excludedSegments: body.excluded_segments || [],
        filters: body.filters || [],
        includeSubscriptionIds: body.include_subscription_ids || [],
        includeExternalIds: body.include_external_user_ids || [],
        channels: body.channels || null,
      }),
    };
  });

  fastify.get('/admin/api/apps/:appId/segments', appScope, async (request) => ({
    segments: await many(
      `SELECT id, name, description, filters, is_system, cached_count, cached_at
       FROM segments WHERE app_id = $1 ORDER BY is_system DESC, name`, [request.pushApp.id]),
  }));

  fastify.get('/admin/api/apps/:appId/templates', appScope, async (request) => ({
    templates: await many('SELECT * FROM templates WHERE app_id = $1 ORDER BY name',
      [request.pushApp.id]),
  }));

  fastify.get('/admin/api/apps/:appId/automations', appScope, async (request) => ({
    automations: await many('SELECT * FROM automations WHERE app_id = $1 ORDER BY created_at DESC',
      [request.pushApp.id]),
  }));

  fastify.post('/admin/api/apps/:appId/segments', editor, async (request, reply) => {
    const { name, description, filters = [] } = request.body || {};
    if (!name) throw badRequest('El segmento necesita un nombre');
    buildFilterSql(filters, new Params());        // valida las reglas antes de guardar
    const segment = await one(
      `INSERT INTO segments (app_id, name, description, filters) VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id, lower(name)) DO UPDATE
         SET filters = EXCLUDED.filters, description = EXCLUDED.description, updated_at = now()
       RETURNING *`,
      [request.pushApp.id, name, description || null, JSON.stringify(filters)]);
    segment.cached_count = await countSegment(request.pushApp.id, segment.id);
    await query('UPDATE segments SET cached_count = $2, cached_at = now() WHERE id = $1',
      [segment.id, segment.cached_count]);
    reply.code(201);
    return { segment };
  });

  fastify.delete('/admin/api/apps/:appId/segments/:id', editor, async (request) => {
    const { rowCount } = await query(
      'DELETE FROM segments WHERE app_id = $1 AND id = $2 AND NOT is_system',
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Segmento no encontrado o es del sistema');
    return { deleted: true };
  });

  fastify.post('/admin/api/apps/:appId/automations', editor, async (request, reply) => {
    const { name, trigger, steps = [], status = 'paused', segment_id } = request.body || {};
    if (!name || !trigger?.type) throw badRequest('Faltan el nombre o el disparador');
    if (trigger.type === 'schedule' && !isValidCron(trigger.cron)) {
      throw badRequest('La expresión cron no es válida (5 campos)');
    }
    if (!steps.length) throw badRequest('La automatización necesita al menos un paso');
    const automation = await one(
      `INSERT INTO automations (app_id, name, trigger, steps, status, segment_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [request.pushApp.id, name, trigger, JSON.stringify(steps), status, segment_id || null]);
    reply.code(201);
    return { automation };
  });

  fastify.patch('/admin/api/apps/:appId/automations/:id', editor, async (request) => {
    const { status, name, steps, trigger } = request.body || {};
    const automation = await one(
      `UPDATE automations SET status = COALESCE($3, status), name = COALESCE($4, name),
              steps = COALESCE($5, steps), trigger = COALESCE($6, trigger), updated_at = now()
       WHERE app_id = $1 AND id = $2 RETURNING *`,
      [request.pushApp.id, request.params.id, status || null, name || null,
       steps ? JSON.stringify(steps) : null, trigger || null]);
    if (!automation) throw notFound('Automatización no encontrada');
    return { automation };
  });

  fastify.delete('/admin/api/apps/:appId/automations/:id', editor, async (request) => {
    const { rowCount } = await query('DELETE FROM automations WHERE app_id = $1 AND id = $2',
      [request.pushApp.id, request.params.id]);
    if (!rowCount) throw notFound('Automatización no encontrada');
    return { deleted: true };
  });

  /** Cierra un test A/B enviando la variante ganadora al resto de la audiencia. */
  fastify.post('/admin/api/apps/:appId/notifications/:id/winner', editor, async (request) =>
    sendAbWinner(request.pushApp, request.params.id, {
      variantId: request.body?.variant_id, createdBy: request.admin.user_id }));

  /** Estado del sistema: cola, workers y base de datos. */
  fastify.get('/admin/api/system', auth, async () => {
    const [jobs, dbSize, oldest] = await Promise.all([
      queueStats(),
      one(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`),
      one(`SELECT min(run_at) AS oldest FROM jobs WHERE status = 'pending'`),
    ]);
    return {
      jobs,
      db_size: dbSize.size,
      oldest_pending_job: oldest.oldest,
      version: '1.0.0',
      node: process.version,
      uptime_sec: Math.floor(process.uptime()),
    };
  });
}
