/**
 * Canal Web Push (RFC 8030 + cifrado aes128gcm RFC 8291) con claves VAPID
 * propias de cada app. Funciona en Chrome, Edge, Firefox, Opera, Samsung
 * Internet y Safari 16.4+ (macOS y iOS con la web añadida a la pantalla de inicio).
 */
import webpush from 'web-push';
import config from '../../config.js';
import logger from '../../lib/logger.js';

/** Códigos del proveedor que significan "esta suscripción ya no existe". */
const GONE_CODES = new Set([404, 410]);

export function generateVapidKeys() {
  return webpush.generateVAPIDKeys();
}

/**
 * Envía un payload cifrado a un endpoint de Web Push.
 * Devuelve { ok, statusCode, providerId, errorCode, error, permanent }.
 */
export async function sendWebPush(app, subscription, payload, options = {}) {
  if (!app.vapid_public || !app.vapid_private) {
    return { ok: false, permanent: true, errorCode: 'no_vapid',
             error: 'La app no tiene claves VAPID configuradas' };
  }
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
  };

  try {
    const res = await webpush.sendNotification(pushSubscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: app.vapid_subject || config.push.vapidSubject,
        publicKey: app.vapid_public,
        privateKey: app.vapid_private,
      },
      TTL: options.ttl ?? 259200,
      urgency: options.urgency || (options.priority >= 8 ? 'high' : 'normal'),
      topic: options.topic || undefined,   // colapsa mensajes del mismo tema
      timeout: config.push.webPushTimeoutMs,
    });
    return {
      ok: true,
      statusCode: res.statusCode,
      providerId: res.headers?.location || null,
    };
  } catch (err) {
    const statusCode = err.statusCode || 0;
    const permanent = GONE_CODES.has(statusCode) || statusCode === 400 || statusCode === 403;
    if (!permanent && statusCode !== 429) {
      logger.debug('web push falló', { statusCode, message: err.message });
    }
    return {
      ok: false,
      statusCode,
      permanent,
      retryAfter: Number(err.headers?.['retry-after']) || null,
      errorCode: statusCode ? `http_${statusCode}` : 'network_error',
      error: String(err.body || err.message || 'error desconocido').slice(0, 500),
    };
  }
}

/** El endpoint expiró o fue revocado: la suscripción debe marcarse inválida. */
export const isGone = (result) => GONE_CODES.has(result.statusCode);

export default { sendWebPush, generateVapidKeys, isGone };
