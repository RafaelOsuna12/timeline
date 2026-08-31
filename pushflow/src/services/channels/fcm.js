/**
 * Canal Android vía FCM HTTP v1.
 *
 * No usa firebase-admin: firma un JWT RS256 con la cuenta de servicio y pide
 * el access token a Google (cacheado hasta 5 min antes de expirar).
 * Se envían mensajes *data-only* para que el SDK de Android construya la
 * notificación (imagen grande, botones, deep link) y pueda registrar la
 * recepción real en la analítica.
 */
import config from '../../config.js';
import { signJwtRS256, decryptSecret } from '../../lib/crypto.js';
import logger from '../../lib/logger.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// appId -> { token, expiresAt }
const tokenCache = new Map();

/** Errores de FCM que invalidan el token del dispositivo de forma permanente. */
const PERMANENT_ERRORS = new Set([
  'UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH', 'NOT_FOUND',
]);

export function hasFcmCredentials(app) {
  return Boolean(app.fcm_project_id && app.fcm_client_email && app.fcm_private_key);
}

async function getAccessToken(app, cacheKey = app.id) {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 300_000) return cached.token;

  const privateKey = decryptSecret(app.fcm_private_key).replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwtRS256({
    iss: app.fcm_client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }, privateKey);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(config.push.fcmTimeoutMs),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    tokenCache.delete(cacheKey);
    throw new Error(`OAuth FCM falló (${res.status}): ${body.error_description || body.error || 'sin detalle'}`);
  }
  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  });
  return body.access_token;
}

/** Invalida el token cacheado (por ejemplo, al rotar credenciales de la app). */
export function clearTokenCache(appId) {
  if (appId) tokenCache.delete(appId); else tokenCache.clear();
}

/** Envía un mensaje FCM v1. Devuelve { ok, providerId, errorCode, permanent }. */
export async function sendFcm(app, message) {
  if (!hasFcmCredentials(app)) {
    return { ok: false, permanent: true, errorCode: 'no_fcm_credentials',
             error: 'La app no tiene credenciales FCM configuradas' };
  }
  let accessToken;
  try {
    accessToken = await getAccessToken(app);
  } catch (err) {
    return { ok: false, permanent: false, errorCode: 'fcm_auth_error', error: err.message };
  }

  const url = `${config.push.fcmEndpoint}/${app.fcm_project_id}/messages:send`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(config.push.fcmTimeoutMs),
    });
    const body = await res.json().catch(() => ({}));

    if (res.ok) return { ok: true, statusCode: res.status, providerId: body.name || null };

    if (res.status === 401 || res.status === 403) tokenCache.delete(app.id);

    const detail = body.error?.details?.find((d) => d['@type']?.includes('FcmError'));
    const errorCode = detail?.errorCode || body.error?.status || `http_${res.status}`;
    const permanent = PERMANENT_ERRORS.has(errorCode) || res.status === 400 || res.status === 404;

    if (!permanent) logger.debug('FCM falló', { status: res.status, errorCode });
    return {
      ok: false,
      statusCode: res.status,
      permanent,
      errorCode,
      error: String(body.error?.message || `HTTP ${res.status}`).slice(0, 500),
      retryAfter: Number(res.headers.get('retry-after')) || null,
    };
  } catch (err) {
    return {
      ok: false, permanent: false, statusCode: 0,
      errorCode: err.name === 'TimeoutError' ? 'timeout' : 'network_error',
      error: err.message,
    };
  }
}

/** El token del dispositivo ya no es válido. */
export const isUnregistered = (result) =>
  result.errorCode === 'UNREGISTERED' || result.errorCode === 'NOT_FOUND';

/** Valida credenciales pidiendo un access token (usado desde el panel). */
export async function verifyCredentials(app) {
  const cacheKey = `verify:${app.fcm_project_id}`;
  try {
    await getAccessToken(app, cacheKey);
    clearTokenCache(cacheKey);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { sendFcm, hasFcmCredentials, isUnregistered, clearTokenCache, verifyCredentials };
