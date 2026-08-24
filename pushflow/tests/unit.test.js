/** Pruebas unitarias de la lógica pura (no requieren base de datos). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'clave-de-pruebas-0123456789abcdef';

const { buildFilterSql } = await import('../src/services/audience.js');
const { Params } = await import('../src/db/index.js');
const payload = await import('../src/services/payload.js');
const { computeSendTime } = await import('../src/services/dispatcher.js');
const { cronMatches } = await import('../src/lib/cron.js');
const validate = await import('../src/lib/validate.js');
const crypto = await import('../src/lib/crypto.js');
const { parseUserAgent } = await import('../src/lib/useragent.js');

test('los filtros de tag generan comparación numérica cuando procede', () => {
  const p = new Params();
  const sql = buildFilterSql([{ field: 'tag', key: 'nivel', relation: '>', value: '10' }], p);
  assert.match(sql, /::numeric > \$2/);
  assert.deepEqual(p.values, ['nivel', 10]);
});

test('el operador OR separa grupos de filtros', () => {
  const p = new Params();
  const sql = buildFilterSql([
    { field: 'country', relation: '=', value: 'MX' },
    { operator: 'OR' },
    { field: 'language', relation: '=', value: 'es' },
  ], p);
  assert.match(sql, /\) OR \(/);
});

test('hours_ago con relación ">" busca marcas más antiguas', () => {
  const p = new Params();
  const sql = buildFilterSql([{ field: 'last_session', relation: '>', hours_ago: 48 }], p);
  assert.match(sql, /s\.last_seen_at < now\(\)/);
});

test('un campo de filtro desconocido se rechaza', () => {
  assert.throws(() => buildFilterSql([{ field: 'inventado', value: 'x' }], new Params()),
    /Campo de filtro desconocido/);
});

test('el radio geográfico usa la fórmula de Haversine', () => {
  const p = new Params();
  const sql = buildFilterSql([{ field: 'location', lat: 19.43, long: -99.13, radius: 5000 }], p);
  assert.match(sql, /6371000/);
  assert.deepEqual(p.values, [19.43, -99.13, 5000]);
});

test('el idioma degrada de es-MX a es y luego a en', () => {
  assert.equal(payload.pickLanguage({ 'es-mx': 'A', es: 'B', en: 'C' }, 'es-MX'), 'A');
  assert.equal(payload.pickLanguage({ es: 'B', en: 'C' }, 'es-MX'), 'B');
  assert.equal(payload.pickLanguage({ en: 'C' }, 'fr'), 'C');
  assert.equal(payload.pickLanguage({ pt: 'D' }, 'fr'), 'D');
});

test('las plantillas {{tag}} se sustituyen con valor por defecto', () => {
  const sub = { tags: { nombre: 'Ana' }, external_user_id: 'u1' };
  assert.equal(payload.interpolate('Hola {{nombre}}', sub), 'Hola Ana');
  assert.equal(payload.interpolate('Hola {{apellido|amigo}}', sub), 'Hola amigo');
  assert.equal(payload.interpolate('ID {{external_id}}', sub), 'ID u1');
});

test('el payload web incluye emojis, imagen y botones con claves compactas', () => {
  const notification = {
    id: 'n1', app_id: 'a1',
    headings: { es: '🔥 Oferta' }, contents: { es: 'Hoy 50% 🎉' },
    image_url: 'https://x/i.jpg', icon_url: 'https://x/ic.png',
    url: 'https://x/oferta', ttl: 3600, priority: 10,
    buttons: [{ id: 'ver', text: 'Ver', url: 'https://x/ver' }],
    data: { pedido: 42 },
  };
  const out = payload.buildWebPushPayload(notification, { language: 'es' }, { deliveryId: 9 });
  assert.equal(out.t, '🔥 Oferta');
  assert.equal(out.b, 'Hoy 50% 🎉');
  assert.equal(out.im, 'https://x/i.jpg');
  assert.equal(out.ap, 'a1');
  assert.equal(out.dl, '9');
  assert.deepEqual(out.a, [{ i: 'ver', t: 'Ver', u: 'https://x/ver' }]);
  assert.deepEqual(out.d, { pedido: 42 });
});

test('el mensaje FCM es data-only y convierte todo a texto', () => {
  const notification = {
    id: 'n1', headings: { es: 'Título 🚀' }, contents: { es: 'Cuerpo' },
    app_url: 'miapp://pedido/42', image_url: 'https://x/i.jpg',
    priority: 10, ttl: 3600, android_channel_id: 'ofertas',
    buttons: [{ id: 'b1', text: 'Abrir' }], data: { x: 1 },
  };
  const message = payload.buildFcmMessage(notification, { fcm_token: 'tok', language: 'es' });
  assert.equal(message.token, 'tok');
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.ttl, '3600s');
  assert.equal(message.data.pf_url, 'miapp://pedido/42');
  assert.equal(message.data.pf_channel, 'ofertas');
  assert.equal(typeof message.data.pf_buttons, 'string');
  assert.equal(message.notification, undefined, 'debe ser data-only');
  for (const value of Object.values(message.data)) assert.equal(typeof value, 'string');
});

test('la variante A/B sustituye título y mensaje', () => {
  const notification = {
    id: 'n1', headings: { es: 'A' }, contents: { es: 'a' },
    ab_test: { variants: [{ id: 'B', headings: { es: 'B' }, contents: { es: 'b' } }] },
  };
  const out = payload.buildWebPushPayload(notification, { language: 'es' }, { variant: 'B' });
  assert.equal(out.t, 'B');
  assert.equal(out.b, 'b');
});

test('las horas silenciosas aplazan el envío al final de la ventana', () => {
  const settings = { quiet_hours: { enabled: true, start: '22:00', end: '08:00' } };
  const when = computeSendTime({ respect_quiet_hours: true }, { timezone_offset: 0 },
    settings, new Date('2026-08-24T23:30:00Z'));
  assert.equal(when.toISOString(), '2026-08-25T08:00:00.000Z');
});

test('la entrega por huso horario respeta la hora local', () => {
  const when = computeSendTime(
    { delayed_option: 'timezone', delivery_time_of_day: '09:00' },
    { timezone_offset: -360 }, {}, new Date('2026-08-24T12:00:00Z'));
  assert.equal(when.toISOString(), '2026-08-24T15:00:00.000Z');   // 09:00 en UTC-6
});

test('el evaluador cron reconoce pasos y rangos', () => {
  assert.ok(cronMatches('0 9 * * *', new Date('2026-08-24T09:00:00Z')));
  assert.ok(!cronMatches('0 9 * * *', new Date('2026-08-24T10:00:00Z')));
  assert.ok(cronMatches('*/15 * * * *', new Date('2026-08-24T10:30:00Z')));
  assert.ok(cronMatches('0 9 * * 1-5', new Date('2026-08-24T09:00:00Z'))); // lunes
  assert.ok(!cronMatches('0 9 * * 6', new Date('2026-08-24T09:00:00Z')));
});

test('los tags se validan y `null` marca borrado', () => {
  assert.deepEqual(validate.sanitizeTags({ plan: 'pro', nivel: 7, viejo: null }),
    { plan: 'pro', nivel: '7', viejo: null });
  assert.throws(() => validate.sanitizeTags({ x: { anidado: 1 } }), /valor simple/);
});

test('el contenido localizado acepta texto plano y mapas por idioma', () => {
  assert.deepEqual(validate.localized('Hola', 'contents'), { en: 'Hola' });
  assert.deepEqual(validate.localized({ ES: 'Hola' }, 'contents'), { es: 'Hola' });
  assert.throws(() => validate.localized({ espanol: 'Hola' }, 'contents'), /idioma inválido/);
});

test('parseWhen entiende fechas ISO y expresiones relativas', () => {
  const when = validate.parseWhen('in 2 hours');
  assert.ok(when.getTime() > Date.now() + 7_000_000);
  assert.equal(validate.parseWhen('2026-09-01T10:00:00Z').toISOString(), '2026-09-01T10:00:00.000Z');
});

test('las contraseñas usan scrypt con sal aleatoria', () => {
  const hash = crypto.hashPassword('secreta-larga');
  assert.notEqual(hash, crypto.hashPassword('secreta-larga'));
  assert.ok(crypto.verifyPassword('secreta-larga', hash));
  assert.ok(!crypto.verifyPassword('otra', hash));
});

test('las credenciales se cifran con AES-256-GCM', () => {
  const encrypted = crypto.encryptSecret('-----BEGIN PRIVATE KEY-----');
  assert.match(encrypted, /^v1\./);
  assert.equal(crypto.decryptSecret(encrypted), '-----BEGIN PRIVATE KEY-----');
});

test('el user-agent identifica navegador y sistema operativo', () => {
  const chrome = parseUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0');
  assert.equal(chrome.browserName, 'chrome');
  assert.equal(chrome.os, 'windows');
  const android = parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile');
  assert.equal(android.deviceType, 'mobile');
  assert.equal(android.os, 'android');
});
