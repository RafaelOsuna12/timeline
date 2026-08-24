/**
 * Prueba de extremo a extremo del envío web push contra un servidor simulado:
 * crea una suscripción con claves reales, envía una notificación y comprueba
 * que el payload llega cifrado y que la analítica se actualiza.
 */
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pool, one, many } from '../src/db/index.js';
import { upsertSubscription } from '../src/services/subscriptions.js';
import { createNotification } from '../src/services/notifications.js';
import { dispatchNotification, sendBatch } from '../src/services/dispatcher.js';
import { claim, complete } from '../src/services/queue.js';
import { trackClicked, trackDisplayed, notificationReport } from '../src/services/analytics.js';

// Certificado autofirmado: el protocolo Web Push exige TLS.
const tls = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', '/tmp/pf-test.key', '-out', '/tmp/pf-test.crt', '-days', '1',
  '-subj', '/CN=127.0.0.1'], { stdio: ['ignore', 'pipe', 'ignore'] }) && {
  key: readFileSync('/tmp/pf-test.key'), cert: readFileSync('/tmp/pf-test.crt') };
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const received = [];
const mock = createServer(tls, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
    res.writeHead(201, { location: `https://mock/receipt/${received.length}` });
    res.end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

// Claves de cliente válidas (P-256 + auth secret de 16 bytes)
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const p256dh = ecdh.getPublicKey().toString('base64url');
const auth = randomBytes(16).toString('base64url');

const app = await one(`SELECT * FROM apps WHERE slug = 'demo-pushflow'`);
const { subscription } = await upsertSubscription(app.id, {
  endpoint: `https://127.0.0.1:${port}/push/abc123`,
  keys: { p256dh, auth },
  channel: 'web_push',
  language: 'es',
  timezone_offset: -360,
  external_user_id: 'prueba-e2e',
  tags: { plan: 'pro', ciudad: 'CDMX' },
}, { ip: '187.190.1.1', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0' });
console.log('1. suscripción creada:', subscription.id, subscription.channel);

const { notification } = await createNotification(app, {
  headings: { es: '🎉 ¡Hola {{tags.ciudad|amigo}}!', en: '🎉 Hello!' },
  contents: { es: 'Tu pedido va en camino 🚚', en: 'Your order is on the way' },
  url: 'https://ejemplo.com/pedido/42',
  big_picture: 'https://ejemplo.com/mapa.jpg',
  buttons: [{ id: 'ver', text: 'Ver pedido', url: 'https://ejemplo.com/pedido/42' },
            { id: 'ayuda', text: 'Ayuda' }],
  include_subscription_ids: [subscription.id],
  name: 'prueba e2e',
});
console.log('2. notificación creada:', notification.id, notification.status);

await dispatchNotification(notification.id);
const jobs = await claim('test-worker', 10);
for (const job of jobs) {
  if (job.type === 'notification.batch') await sendBatch(job.payload);
  await complete(job.id);
}
console.log('3. lotes procesados:', jobs.filter((j) => j.type === 'notification.batch').length);
console.log('4. peticiones recibidas por el servidor simulado:', received.length,
  received[0] ? `(${received[0].bytes} bytes cifrados, TTL=${received[0].headers.ttl})` : '');

const delivery = await one(
  `SELECT id, status, provider_id FROM deliveries WHERE notification_id = $1`, [notification.id]);
console.log('5. entrega:', delivery.status, '| id proveedor:', delivery.provider_id);

await trackDisplayed({ appId: app.id, notificationId: notification.id,
  subscriptionId: subscription.id, deliveryId: delivery.id });
await trackClicked({ appId: app.id, notificationId: notification.id,
  subscriptionId: subscription.id, deliveryId: delivery.id, actionId: 'ver',
  url: 'https://ejemplo.com/pedido/42' });

const report = await notificationReport(notification.id);
console.log('6. métricas:', JSON.stringify(report.stats));
console.log('7. clics por acción:', JSON.stringify(report.by_action));

const events = await many(
  `SELECT type, name, action_id FROM events WHERE notification_id = $1 ORDER BY id`, [notification.id]);
console.log('8. eventos registrados:', events.map((e) => e.type + (e.action_id ? `:${e.action_id}` : '')).join(', '));

mock.close();
await pool.end();
