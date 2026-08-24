/**
 * Webhooks salientes: reenvía eventos del sistema al backend del cliente.
 * Firma cada petición con HMAC-SHA256 en la cabecera `X-PushFlow-Signature`.
 */
import { many, query } from '../db/index.js';
import { signWebhook } from '../lib/crypto.js';
import { enqueue } from './queue.js';
import logger from '../lib/logger.js';

export const WEBHOOK_EVENTS = [
  'notification.sent', 'notification.completed', 'notification.clicked',
  'subscription.created', 'subscription.updated', 'subscription.removed',
  'outcome.recorded',
];

/** Encola la entrega del evento a todos los webhooks suscritos de la app. */
export async function fireWebhook(appId, event, payload) {
  const hooks = await many(
    `SELECT id FROM webhooks WHERE app_id = $1 AND active AND $2 = ANY(events)`,
    [appId, event]);
  for (const hook of hooks) {
    await enqueue('webhook.deliver', { webhookId: hook.id, event, payload }, {
      appId, priority: 150, maxAttempts: 6,
    });
  }
  return hooks.length;
}

/** Entrega efectiva (la ejecuta el worker). */
export async function deliverWebhook({ webhookId, event, payload }) {
  const [hook] = await many('SELECT * FROM webhooks WHERE id = $1 AND active', [webhookId]);
  if (!hook) return { skipped: true };

  const body = JSON.stringify({ event, app_id: hook.app_id, created_at: new Date().toISOString(), data: payload });
  const signature = signWebhook(hook.secret, body);

  let statusCode = 0, error = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pushflow-signature': signature,
        'x-pushflow-event': event,
        'user-agent': 'PushFlow-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    statusCode = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err.message;
  }

  await query(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, error, attempts)
     VALUES ($1,$2,$3,$4,$5,1)`,
    [webhookId, event, payload, statusCode || null, error]);

  if (error) {
    logger.warn('entrega de webhook fallida', { webhookId, event, statusCode, error });
    throw new Error(`Webhook falló: ${error}`);   // fuerza el reintento con backoff
  }
  return { statusCode };
}

export default { fireWebhook, deliverWebhook, WEBHOOK_EVENTS };
