/**
 * Autenticación.
 *
 *  - API REST:  `Authorization: Bearer pf_xxx` (clave de API por app)
 *  - Panel:     cookie de sesión firmada + usuario de `admin_users`
 *  - Público:   endpoints del SDK, identificados solo por `app_id`
 */
import { one, query } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { unauthorized, forbidden, notFound } from '../lib/errors.js';

const appCache = new Map();          // appId -> { app, expiresAt }
const APP_CACHE_MS = 30_000;

export async function loadApp(appId, { fresh = false } = {}) {
  if (!fresh) {
    const cached = appCache.get(appId);
    if (cached && cached.expiresAt > Date.now()) return cached.app;
  }
  const app = await one(`SELECT * FROM apps WHERE id = $1 AND status <> 'archived'`, [appId]);
  if (app) appCache.set(appId, { app, expiresAt: Date.now() + APP_CACHE_MS });
  return app;
}

export function invalidateAppCache(appId) {
  if (appId) appCache.delete(appId); else appCache.clear();
}

/** Resuelve una clave de API y devuelve { app, apiKey }. */
export async function authenticateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('pf_')) throw unauthorized('Formato de clave de API inválido');
  const prefix = rawKey.split('_')[1];
  const record = await one(
    `SELECT * FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL`, [prefix]);
  if (!record || record.key_hash !== sha256(rawKey)) throw unauthorized('Clave de API inválida');

  const app = await loadApp(record.app_id);
  if (!app) throw unauthorized('La app de esta clave ya no existe');
  if (app.status === 'paused') throw forbidden('La app está pausada');

  // Marca de uso, sin bloquear la petición.
  query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [record.id]).catch(() => {});
  return { app, apiKey: record };
}

function bearerFrom(request) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (header.startsWith('Basic ')) {
    // Compatibilidad con clientes que envían la clave como usuario básico.
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.split(':')[0];
  }
  return request.headers['x-api-key'] || null;
}

/** Hook: exige una clave de API válida. Deja `request.app` y `request.apiKey`. */
export async function requireApiKey(request) {
  const { app, apiKey } = await authenticateApiKey(bearerFrom(request));
  request.pushApp = app;
  request.apiKey = apiKey;
}

/** Comprueba que la clave tenga un scope concreto. */
export function requireScope(scope) {
  return async (request) => {
    if (!request.apiKey) await requireApiKey(request);
    const scopes = request.apiKey.scopes || [];
    if (!scopes.includes(scope) && !scopes.includes('*')) {
      throw forbidden(`La clave de API no tiene el permiso \`${scope}\``);
    }
  };
}

/** Hook: sesión del panel a partir de la cookie. */
export async function requireAdmin(request) {
  const token = request.cookies?.pf_session;
  if (!token) throw unauthorized('Sesión no iniciada');
  const session = await one(
    `SELECT s.id, s.expires_at, u.id AS user_id, u.email, u.name, u.role, u.org_id, u.status
     FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]);
  if (!session) throw unauthorized('Sesión caducada, vuelve a iniciar sesión');
  if (session.status !== 'active') throw forbidden('Usuario deshabilitado');
  request.admin = session;
}

/** Exige un rol mínimo (owner > admin > member > viewer). */
export function requireRole(...roles) {
  return async (request) => {
    if (!request.admin) await requireAdmin(request);
    if (!roles.includes(request.admin.role)) {
      throw forbidden(`Se requiere uno de estos roles: ${roles.join(', ')}`);
    }
  };
}

/** Carga la app de la ruta comprobando que pertenece a la organización del usuario. */
export async function loadAdminApp(request) {
  if (!request.admin) await requireAdmin(request);
  const appId = request.params.appId || request.params.id;
  const app = await one(`SELECT * FROM apps WHERE id = $1 AND org_id = $2`,
    [appId, request.admin.org_id]);
  if (!app) throw notFound('App no encontrada');
  request.pushApp = app;
  return app;
}

export default {
  requireApiKey, requireScope, requireAdmin, requireRole, loadAdminApp,
  authenticateApiKey, loadApp, invalidateAppCache,
};
