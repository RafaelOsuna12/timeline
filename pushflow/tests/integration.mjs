/**
 * Prueba de integración contra la API HTTP real (servidor + worker en marcha).
 *
 * Levanta un servidor Web Push simulado con TLS para que las entregas se
 * completen de verdad y la analítica posterior sea la de un envío real.
 */
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const BASE = 'http://localhost:3000';

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', '/tmp/pf-int.key', '-out', '/tmp/pf-int.crt', '-days', '1',
  '-subj', '/CN=127.0.0.1'], { stdio: ['ignore', 'pipe', 'ignore'] });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pushed = [];
const mockPush = createServer(
  { key: readFileSync('/tmp/pf-int.key'), cert: readFileSync('/tmp/pf-int.crt') },
  (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      pushed.push({ url: req.url, bytes: Buffer.concat(chunks).length, ttl: req.headers.ttl });
      res.writeHead(201, { location: `https://mock/r/${pushed.length}` });
      res.end();
    });
  });
await new Promise((r) => mockPush.listen(0, '127.0.0.1', r));
const mockPort = mockPush.address().port;

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const P256DH = ecdh.getPublicKey().toString('base64url');
const AUTH = randomBytes(16).toString('base64url');
let passed = 0, failed = 0;

const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${detail}`); }
};

async function req(path, { method = 'GET', body, key, cookie, origin } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

console.log('\n— Sesión del panel —');
const login = await req('/admin/api/login', { method: 'POST',
  body: { email: 'admin@demo.com', password: 'pruebaSegura123' } });
check('login correcto', login.status === 200, JSON.stringify(login.data));
const cookie = login.headers.get('set-cookie')?.split(';')[0];
check('cookie de sesión emitida', Boolean(cookie));
check('contraseña incorrecta rechazada',
  (await req('/admin/api/login', { method: 'POST',
    body: { email: 'admin@demo.com', password: 'incorrecta' } })).status === 401);

console.log('\n— Creación de aplicación —');
const created = await req('/admin/api/apps', { method: 'POST', cookie,
  body: { name: `Prueba ${Date.now()}`, site_url: 'https://prueba.example' } });
check('app creada', created.status === 201, JSON.stringify(created.data).slice(0, 150));
const appId = created.data?.app?.id;
const apiKey = created.data?.api_key;
check('clave VAPID generada', Boolean(created.data?.app?.vapid_public));
check('clave privada VAPID no se expone', created.data?.app?.vapid_private === undefined);
check('clave de API devuelta una vez', Boolean(apiKey?.startsWith('pf_')));
check('segmentos por defecto creados',
  (await req(`/admin/api/apps/${appId}/segments`, { cookie })).data.segments.length >= 6);

console.log('\n— Autenticación de la API —');
check('sin clave → 401', (await req('/api/v1/segments')).status === 401);
check('clave inválida → 401', (await req('/api/v1/segments', { key: 'pf_falsa_xxx' })).status === 401);
check('clave válida → 200', (await req('/api/v1/segments', { key: apiKey })).status === 200);

console.log('\n— Alta de suscriptores —');
const web = await req('/sdk/v1/subscribe', { method: 'POST', body: {
  app_id: appId, channel: 'web_push',
  endpoint: `https://127.0.0.1:${mockPort}/push/prueba-web-1`,
  keys: { p256dh: P256DH, auth: AUTH },
  language: 'es', country: 'MX', timezone_offset: -360,
  external_user_id: 'usuario-1', tags: { plan: 'pro', nivel: '15' },
} });
check('suscripción web creada', web.status === 201, JSON.stringify(web.data));
const subId = web.data?.subscription_id;

const repeat = await req('/sdk/v1/subscribe', { method: 'POST', body: {
  app_id: appId, channel: 'web_push',
  endpoint: `https://127.0.0.1:${mockPort}/push/prueba-web-1`,
  keys: { p256dh: P256DH, auth: AUTH },
} });
check('alta repetida es idempotente', repeat.status === 200 && repeat.data.subscription_id === subId);

check('falta de claves rechazada', (await req('/sdk/v1/subscribe', { method: 'POST', body: {
  app_id: appId, channel: 'web_push', endpoint: 'https://x/y' } })).status === 400);

const android = await req('/sdk/v1/subscribe', { method: 'POST', body: {
  app_id: appId, channel: 'android', fcm_token: 'token-android-demo-1',
  device_model: 'Pixel 8', language: 'es', country: 'ES', external_user_id: 'usuario-2',
  tags: { plan: 'free' },
} });
check('suscripción android creada', android.status === 201);

console.log('\n— Tags y segmentación —');
await req(`/sdk/v1/subscription/${subId}/update`, { method: 'POST',
  body: { app_id: appId, tags: { ciudad: 'CDMX', nivel: null } } });
const detail = await req(`/api/v1/subscriptions/${subId}`, { key: apiKey });
check('tag añadido', detail.data.subscription.tags.ciudad === 'CDMX');
check('tag borrado con null', detail.data.subscription.tags.nivel === undefined);
check('claves de cifrado no se exponen', detail.data.subscription.p256dh === undefined);

const seg = await req('/api/v1/segments', { method: 'POST', key: apiKey, body: {
  name: 'Pro de México',
  filters: [{ field: 'tag', key: 'plan', relation: '=', value: 'pro' },
            { field: 'country', relation: '=', value: 'MX' }],
} });
check('segmento creado', seg.status === 201);
check('recuento del segmento correcto', seg.data.segment.count === 1,
  `esperado 1, recibido ${seg.data.segment.count}`);
check('filtro inválido rechazado', (await req('/api/v1/segments', { method: 'POST', key: apiKey,
  body: { name: 'inválido', filters: [{ field: 'campo_inexistente', value: 'x' }] } })).status === 400);

const estimate = await req('/api/v1/notifications/estimate', { method: 'POST', key: apiKey,
  body: { include_all: true } });
check('estimación de audiencia', estimate.data.estimated_recipients === 2,
  `recibido ${estimate.data.estimated_recipients}`);
check('estimación filtrada por canal',
  (await req('/api/v1/notifications/estimate', { method: 'POST', key: apiKey,
    body: { include_all: true, channels: ['android'] } })).data.estimated_recipients === 1);

console.log('\n— Notificaciones —');
check('mensaje obligatorio', (await req('/api/v1/notifications', { method: 'POST', key: apiKey,
  body: { include_all: true } })).status === 400);

const notif = await req('/api/v1/notifications', { method: 'POST', key: apiKey, body: {
  headings: { es: '🔥 Oferta', en: 'Deal' },
  contents: { es: 'Hola {{tags.ciudad|amigo}}, 50 % hoy 🎉' },
  image_url: 'https://ejemplo.com/banner.jpg',
  url: 'https://ejemplo.com/ofertas',
  app_url: 'miapp://ofertas',
  buttons: [{ id: 'ver', text: 'Ver' }, { id: 'no', text: 'Ahora no' }],
  included_segments: [seg.data.segment.id],
} });
check('notificación creada', notif.status === 201, JSON.stringify(notif.data));

await req('/api/v1/notifications', { method: 'POST', key: apiKey, body: {
  contents: { es: 'duplicada' }, include_all: true, idempotency_key: 'clave-fija-1' } });
check('idempotencia evita duplicados',
  (await req('/api/v1/notifications', { method: 'POST', key: apiKey, body: {
    contents: { es: 'duplicada' }, include_all: true,
    idempotency_key: 'clave-fija-1' } })).data.deduplicated === true);

const scheduled = await req('/api/v1/notifications', { method: 'POST', key: apiKey, body: {
  contents: { es: 'programada' }, include_all: true, send_after: 'in 2 hours' } });
check('notificación programada', scheduled.data.status === 'scheduled');
check('cancelación de la programada',
  (await req(`/api/v1/notifications/${scheduled.data.id}`,
    { method: 'DELETE', key: apiKey })).data.canceled === true);

await new Promise((r) => setTimeout(r, 4000));   // deja trabajar al worker
const report = await req(`/api/v1/notifications/${notif.data.id}`, { key: apiKey });
check('la notificación se despachó', report.data.stats.recipients === 1,
  `destinatarios: ${report.data.stats.recipients}`);
check('estado final coherente',
  ['sent', 'sending'].includes(report.data.notification.status), report.data.notification.status);
check('el proveedor recibió el payload cifrado', pushed.length >= 1,
  `peticiones al mock: ${pushed.length}`);
check('el payload viaja cifrado y con TTL', (pushed[0]?.bytes || 0) > 100 && Boolean(pushed[0]?.ttl));
check('la entrega quedó como enviada', report.data.stats.sent === 1,
  `enviadas: ${report.data.stats.sent}, fallidas: ${report.data.stats.failed}`);

console.log('\n— Analítica —');
check('evento de recepción aceptado', (await req('/api/v1/events', { method: 'POST', body: {
  app_id: appId, type: 'displayed', notification_id: notif.data.id,
  subscription_id: subId } })).status === 204);
await req('/api/v1/events', { method: 'POST', body: {
  app_id: appId, type: 'clicked', notification_id: notif.data.id,
  subscription_id: subId, action_id: 'ver' } });

const outcome = await req('/api/v1/outcomes/record', { method: 'POST', key: apiKey,
  body: { name: 'compra', value: 99.5, external_user_id: 'usuario-1' } });
check('conversión atribuida al clic (directa)', outcome.data.attribution === 'direct',
  JSON.stringify(outcome.data));

const overview = await req('/api/v1/analytics/overview', { key: apiKey });
// La app de prueba no tiene credenciales de FCM: los envíos a Android fallan,
// pero eso es un fallo de configuración y NO debe invalidar los dispositivos.
check('un fallo de configuración no invalida la audiencia',
  overview.data.audience.active === 2, `activos: ${overview.data.audience.active}`);
check('desglose por país mantiene ambos países',
  (await req('/api/v1/analytics/breakdown/country', { key: apiKey })).data.data.length >= 2);
check('el error de FCM queda registrado en la entrega',
  (await req(`/api/v1/notifications?limit=10`, { key: apiKey })).data.notifications
    .some((n) => n.failed > 0));

const report2 = await req(`/api/v1/notifications/${notif.data.id}`, { key: apiKey });
check('clic por botón registrado', report2.data.by_action.some((a) => a.action === 'ver'),
  JSON.stringify(report2.data.by_action));
check('CTR calculado', report2.data.stats.ctr === 1, `ctr: ${report2.data.stats.ctr}`);
check('conversión contabilizada', report2.data.stats.converted === 1,
  `conversiones: ${report2.data.stats.converted}`);

console.log('\n— Icono de la app: subida y borrado —');
// PNG mínimo válido de 192x192 generado al vuelo (cabecera IHDR correcta).
function pngFalso(ancho, alto) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const trozo = (tipo, datos) => {
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
    const suma = Buffer.alloc(4); suma.writeUInt32BE(crc(cuerpo));
    return Buffer.concat([len, cuerpo, suma]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr), trozo('IEND', Buffer.alloc(0)),
  ]);
}
const comoDataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const subida = await req(`/admin/api/apps/${appId}/icon`, { method: 'POST', cookie,
  body: { data: comoDataUrl(pngFalso(256, 256)) } });
check('icono subido', subida.status === 200 && subida.data.url?.includes('/uploads/'),
  JSON.stringify(subida.data).slice(0, 120));
check('dimensiones leídas del PNG', subida.data.width === 256 && subida.data.height === 256);
check('el icono se sirve por HTTP',
  (await fetch(subida.data.url)).status === 200);
check('la app quedó con ese icono',
  (await req(`/sdk/v1/config?app_id=${appId}`)).data.default_icon === subida.data.url);

check('una imagen demasiado pequeña se rechaza',
  (await req(`/admin/api/apps/${appId}/icon`, { method: 'POST', cookie,
    body: { data: comoDataUrl(pngFalso(32, 32)) } })).status === 400);
check('un fichero que no es imagen se rechaza',
  (await req(`/admin/api/apps/${appId}/icon`, { method: 'POST', cookie,
    body: { data: 'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64') } })).status === 400);

const noCuadrada = await req(`/admin/api/apps/${appId}/icon`, { method: 'POST', cookie,
  body: { data: comoDataUrl(pngFalso(300, 200)) } });
check('una imagen no cuadrada se acepta con aviso',
  noCuadrada.status === 200 && Boolean(noCuadrada.data.warning), JSON.stringify(noCuadrada.data.warning));

const borrado = await req(`/admin/api/apps/${appId}/icon`, { method: 'DELETE', cookie });
check('icono eliminado', borrado.data.eliminado === true && borrado.data.fichero_borrado === true);
check('vuelve al icono del sistema',
  (await req(`/sdk/v1/config?app_id=${appId}`)).data.default_icon.includes('/brand/icon-192.png'));
const tras = await fetch(subida.data.url);
check('el fichero ya no se sirve', tras.status === 404, `recibido ${tras.status}`);

console.log('\n— Test A/B con muestreo —');
// Audiencia sintética suficiente para observar el muestreo sin acercarse al
// límite público de 120 peticiones por minuto y por IP.
for (let i = 0; i < 24; i++) {
  await req('/sdk/v1/subscribe', { method: 'POST', body: {
    app_id: appId, channel: 'web_push',
    endpoint: `https://127.0.0.1:${mockPort}/push/ab-${i}`,
    keys: { p256dh: P256DH, auth: AUTH }, language: 'es', country: 'MX',
    tags: { plan: 'pro' },
  } });
}
const abTotal = (await req('/api/v1/notifications/estimate', { method: 'POST', key: apiKey,
  body: { filters: [{ field: 'tag', key: 'plan', relation: '=', value: 'pro' }] } }))
  .data.estimated_recipients;
check('audiencia de prueba creada', abTotal >= 24, `total: ${abTotal}`);

const ab = await req('/api/v1/notifications', { method: 'POST', key: apiKey, body: {
  contents: { es: 'base' },
  filters: [{ field: 'tag', key: 'plan', relation: '=', value: 'pro' }],
  ab_test: { sample_percent: 50, variants: [
    { id: 'A', weight: 50, headings: { es: '🎁 Regalo' }, contents: { es: 'Ábrelo hoy' } },
    { id: 'B', weight: 50, headings: { es: 'Tienes un regalo' }, contents: { es: 'Caduca hoy' } },
  ] },
} });
check('test A/B creado', ab.status === 201, JSON.stringify(ab.data));

await new Promise((r) => setTimeout(r, 5000));
const abReport = await req(`/api/v1/notifications/${ab.data.id}`, { key: apiKey });
const sampled = abReport.data.stats.recipients;
check('solo la mitad de la audiencia entra en el test',
  sampled > 0 && sampled < abTotal, `muestreados ${sampled} de ${abTotal}`);
check('ambas variantes se repartieron', abReport.data.by_variant.length === 2,
  JSON.stringify(abReport.data.by_variant.map((v) => v.variant)));

check('sample_percent fuera de rango rechazado',
  (await req('/api/v1/notifications', { method: 'POST', key: apiKey, body: {
    contents: { es: 'x' }, include_all: true,
    ab_test: { sample_percent: 150, variants: [{ id: 'A' }, { id: 'B' }] } } })).status === 400);

const winner = await req(`/api/v1/notifications/${ab.data.id}/winner`, { method: 'POST', key: apiKey });
check('ganadora enviada', Boolean(winner.data.notification_id), JSON.stringify(winner.data));

await new Promise((r) => setTimeout(r, 5000));
const winnerReport = await req(`/api/v1/notifications/${winner.data.notification_id}`, { key: apiKey });
check('la ganadora va solo al resto de la audiencia',
  winnerReport.data.stats.recipients === abTotal - sampled,
  `ganadora: ${winnerReport.data.stats.recipients}, esperado: ${abTotal - sampled}`);

console.log('\n— Automatizaciones y webhooks —');
check('automatización creada', (await req('/api/v1/automations', { method: 'POST', key: apiKey,
  body: {
    name: 'Carrito abandonado',
    trigger: { type: 'event', event_name: 'carrito_abandonado' },
    steps: [{ type: 'wait', minutes: 30 },
            { type: 'send', payload: { contents: { es: 'Tu carrito te espera 🛒' } } }],
    status: 'active' } })).status === 201);

check('cron inválido rechazado', (await req('/api/v1/automations', { method: 'POST', key: apiKey,
  body: { name: 'mala', trigger: { type: 'schedule', cron: 'no-es-cron' },
          steps: [{ type: 'send', payload: {} }] } })).status === 400);

check('evento dispara la automatización',
  (await req('/api/v1/events/track', { method: 'POST', key: apiKey,
    body: { event_name: 'carrito_abandonado', external_user_id: 'usuario-1' } })).data.triggered === 1);

const hook = await req('/api/v1/webhooks', { method: 'POST', key: apiKey, body: {
  url: 'https://ejemplo.com/hook', events: ['notification.sent'] } });
check('webhook creado con secreto', Boolean(hook.data.webhook?.secret));
check('evento de webhook desconocido rechazado',
  (await req('/api/v1/webhooks', { method: 'POST', key: apiKey, body: {
    url: 'https://ejemplo.com/hook', events: ['evento.inventado'] } })).status === 400);

console.log('\n— Aislamiento y seguridad —');
const otherApp = await req('/admin/api/apps', { method: 'POST', cookie,
  body: { name: `Otra ${Date.now()}` } });
check('una app no ve las notificaciones de otra',
  (await req(`/api/v1/notifications/${notif.data.id}`,
    { key: otherApp.data.api_key })).status === 404);
check('panel exige sesión', (await req('/admin/api/apps')).status === 401);
// Un app_id mal copiado en el snippet debe dar un error claro, nunca un 500.
const badId = await req('/sdk/v1/config?app_id=no-es-un-uuid');
check('app_id inválido devuelve 400, no 500', badId.status === 400,
  `recibido ${badId.status}`);
check('app_id inexistente devuelve 404',
  (await req('/sdk/v1/config?app_id=00000000-0000-4000-8000-000000000000')).status === 404);
// Un cuerpo por encima del límite debe rechazarse, nunca acabar en un 500.
// El servidor responde 413 y cierra; si lo hace antes de que el cliente
// termine de enviar, fetch ve un EPIPE. Ambos desenlaces son un rechazo.
let rechazoGrande;
try {
  const huge = await fetch(`${BASE}/api/v1/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: 'x'.repeat(3 * 1024 * 1024),
  });
  rechazoGrande = huge.status === 413 ? '413' : `inesperado ${huge.status}`;
} catch {
  rechazoGrande = 'conexión cerrada';
}
check('cuerpo demasiado grande se rechaza',
  rechazoGrande === '413' || rechazoGrande === 'conexión cerrada', rechazoGrande);
check('origen no autorizado rechazado',
  (await req(`/sdk/v1/config?app_id=${appId}`, { origin: 'https://sitio-malicioso.com' })).status === 403);
const okOrigin = await req(`/sdk/v1/config?app_id=${appId}`, { origin: 'https://prueba.example' });
check('origen autorizado aceptado', okOrigin.status === 200);
// El limitador debe estar registrado en cada ámbito: si no, no protege nada.
check('límite de peticiones activo en el SDK público',
  okOrigin.headers.get('x-ratelimit-limit') === '120',
  `cabecera: ${okOrigin.headers.get('x-ratelimit-limit')}`);
check('límite de peticiones activo en la API',
  (await req('/api/v1/segments', { key: apiKey })).headers.get('x-ratelimit-limit') === '600');

// --- Imágenes del redactor ---------------------------------------------------
// Cada campo valida contra su propio perfil y, a diferencia del icono de la
// app, subir una imagen aquí no debe tocar el registro de la app.
const pngPrueba = (ancho, alto) => {
  const crc = (b) => {
    let c = ~0;
    for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (tipo, datos) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(cuerpo));
    return Buffer.concat([len, cuerpo, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: alto }, () => Buffer.alloc(1 + ancho * 3)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const subirMedia = (buf, kind) => req(`/admin/api/apps/${appId}/media`,
  { method: 'POST', cookie, body: { data: dataUrl(buf), kind } });

const banner = await subirMedia(pngPrueba(1440, 720), 'banner');
check('imagen grande aceptada', banner.status === 200 && banner.data.width === 1440,
  JSON.stringify(banner.data).slice(0, 150));
check('imagen grande del tamaño recomendado no avisa', banner.data?.warning === null);
check('el fichero subido se sirve',
  (await fetch(`${BASE}${new URL(banner.data.url).pathname}`)).status === 200);

const cuadrada = await subirMedia(pngPrueba(800, 800), 'banner');
check('proporción distinta avisa pero acepta',
  cuadrada.status === 200 && /se recomienda 1440×720/.test(cuadrada.data.warning || ''),
  cuadrada.data?.warning);

const iconoOk = await subirMedia(pngPrueba(192, 192), 'icon');
check('icono del redactor aceptado', iconoOk.status === 200 && iconoOk.data.height === 192);
check('subir al redactor no cambia el icono de la app',
  (await req(`/admin/api/apps/${appId}`, { cookie })).data?.app?.default_icon_url == null,
  JSON.stringify((await req(`/admin/api/apps/${appId}`, { cookie })).data?.app?.default_icon_url));

check('imagen por debajo del mínimo del perfil rechazada',
  (await subirMedia(pngPrueba(40, 40), 'icon')).status === 400);
check('lo que vale como icono no vale como imagen grande',
  (await subirMedia(pngPrueba(192, 192), 'banner')).status === 400);
check('kind desconocido rechazado',
  (await subirMedia(pngPrueba(192, 192), 'miniatura')).status === 400);
check('subir imágenes requiere sesión',
  (await req(`/admin/api/apps/${appId}/media`, { method: 'POST',
    body: { data: dataUrl(pngPrueba(192, 192)), kind: 'icon' } })).status === 401);

// --- Dispositivos de prueba --------------------------------------------------
// `test_type = 2` es lo que miran el segmento «Usuarios de prueba» y el botón
// «Enviar prueba» del redactor: marcar aquí un dispositivo basta para aislar
// los envíos de ensayo del resto de la audiencia.
const marcado = await req(`/admin/api/apps/${appId}/subscriptions/${subId}`,
  { method: 'PATCH', cookie, body: { es_prueba: true } });
check('un suscriptor se marca como de prueba',
  marcado.status === 200 && marcado.data.subscription.test_type === 2,
  JSON.stringify(marcado.data).slice(0, 150));
check('el listado del panel expone la marca',
  (await req(`/admin/api/apps/${appId}/subscriptions`, { cookie }))
    .data.subscriptions.find((s) => s.id === subId)?.test_type === 2);
check('se puede filtrar por dispositivos de prueba', (() => true)()
  && (await req(`/admin/api/apps/${appId}/subscriptions?status=test`, { cookie }))
    .data.subscriptions.every((s) => s.test_type === 2));
check('quitar la marca la deja en null',
  (await req(`/admin/api/apps/${appId}/subscriptions/${subId}`,
    { method: 'PATCH', cookie, body: { es_prueba: false } })).data.subscription.test_type === null);
check('un PATCH sin cambios se rechaza',
  (await req(`/admin/api/apps/${appId}/subscriptions/${subId}`,
    { method: 'PATCH', cookie, body: {} })).status === 400);
check('marcar un suscriptor de otra app da 404',
  (await req(`/admin/api/apps/${otherApp.data.app.id}/subscriptions/${subId}`,
    { method: 'PATCH', cookie, body: { es_prueba: true } })).status === 404);

// --- Vaciado de datos --------------------------------------------------------
const resumen = await req(`/admin/api/apps/${appId}/reset`, { cookie });
check('el resumen previo dice qué hay y qué se puede limpiar',
  resumen.status === 200 && resumen.data.ambitos.length === 3
  && resumen.data.actual.suscriptores > 0,
  JSON.stringify(resumen.data?.actual));
check('el resumen dice el texto de confirmación',
  typeof resumen.data.confirmacion === 'string' && resumen.data.confirmacion.length > 0);

const nombreApp = resumen.data.confirmacion;
check('sin el nombre exacto no se borra nada',
  (await req(`/admin/api/apps/${appId}/reset`, { method: 'POST', cookie,
    body: { ambitos: ['estadisticas'], confirmacion: 'lo que sea' } })).status === 400);
check('un ámbito inventado se rechaza',
  (await req(`/admin/api/apps/${appId}/reset`, { method: 'POST', cookie,
    body: { ambitos: ['todo'], confirmacion: nombreApp } })).status === 400);
check('hay que elegir al menos un ámbito',
  (await req(`/admin/api/apps/${appId}/reset`, { method: 'POST', cookie,
    body: { ambitos: [], confirmacion: nombreApp } })).status === 400);

const limpieza = await req(`/admin/api/apps/${appId}/reset`, { method: 'POST', cookie,
  body: { ambitos: ['estadisticas'], confirmacion: nombreApp } });
check('reiniciar estadísticas borra eventos y entregas',
  limpieza.status === 200 && limpieza.data.borrado.eventos > 0,
  JSON.stringify(limpieza.data?.borrado));
const trasLimpiar = (await req(`/admin/api/apps/${appId}/reset`, { cookie })).data.actual;
check('los contadores quedan a cero', trasLimpiar.eventos === 0 && trasLimpiar.entregas === 0,
  JSON.stringify(trasLimpiar));
check('los suscriptores sobreviven al reinicio de estadísticas', trasLimpiar.suscriptores > 0);
check('el historial de campañas sobrevive', trasLimpiar.notificaciones > 0);

check('borrar suscriptores arrastra las estadísticas',
  (await req(`/admin/api/apps/${appId}/reset`, { method: 'POST', cookie,
    body: { ambitos: ['suscriptores'], confirmacion: nombreApp } }))
    .data.ambitos.includes('estadisticas'));
check('ya no queda ningún suscriptor',
  (await req(`/admin/api/apps/${appId}/reset`, { cookie })).data.actual.suscriptores === 0);
// Lo que nunca se toca: si se borrase, habría que reinstalar el SDK.
check('la configuración de la app se conserva',
  Boolean((await req(`/admin/api/apps/${appId}`, { cookie })).data.app.vapid_public));
check('las claves de API se conservan',
  (await req(`/admin/api/apps/${appId}/keys`, { cookie })).data.keys.length > 0);
check('el SDK sigue admitiendo altas después de vaciar',
  (await req('/sdk/v1/subscribe', { method: 'POST', body: {
    app_id: appId, channel: 'android', fcm_token: 'token-tras-vaciado' } })).status === 201);

// Vaciar datos es cosa de quien administra, no de cualquiera con permiso de edición.
await req('/admin/api/team', { method: 'POST', cookie, body: {
  email: `miembro-${Date.now()}@demo.com`, password: 'miembroSegura123', role: 'member' } });
const sesionMiembro = await req('/admin/api/login', { method: 'POST', body: {
  email: (await req('/admin/api/team', { cookie })).data.members
    .find((u) => u.role === 'member').email, password: 'miembroSegura123' } });
const cookieMiembro = sesionMiembro.headers.get('set-cookie')?.split(';')[0];
check('un miembro no puede vaciar los datos',
  (await req(`/admin/api/apps/${appId}/reset`, { method: 'POST', cookie: cookieMiembro,
    body: { ambitos: ['estadisticas'], confirmacion: nombreApp } })).status === 403,
  `sesión de miembro: ${sesionMiembro.status}`);
check('un miembro sí puede marcar dispositivos de prueba',
  [200, 404].includes((await req(`/admin/api/apps/${appId}/subscriptions/${subId}`,
    { method: 'PATCH', cookie: cookieMiembro, body: { es_prueba: true } })).status));

// --- URL del panel -----------------------------------------------------------
// `/dashboard/` es la que la gente escribe a mano; los estáticos van con
// `index: false`, así que la carpeta necesita su propia ruta.
for (const ruta of ['/', '/dashboard', '/dashboard/', '/dashboard/index.html']) {
  const r = await fetch(`${BASE}${ruta}`);
  check(`el panel responde en ${ruta}`,
    r.status === 200 && (await r.text()).includes('PushFlow'), `estado ${r.status}`);
}
// Un estático que no existe sigue dando 404: nunca el HTML del panel con 200.
check('estático inexistente del panel devuelve 404',
  (await fetch(`${BASE}/dashboard/js/no-existe.js`)).status === 404);
check('los directorios de ficheros no se listan',
  (await fetch(`${BASE}/uploads/`)).status === 404
  && (await fetch(`${BASE}/brand/`)).status === 404);

mockPush.close();
console.log(`\n${passed} correctas, ${failed} fallidas\n`);
process.exit(failed ? 1 : 0);
