#!/usr/bin/env node
/**
 * Datos de demostración: una app con suscripciones simuladas para probar
 * la segmentación y el panel sin necesidad de tráfico real.
 */
import { randomUUID } from 'node:crypto';
import { pool, one, query } from '../src/db/index.js';
import { generateApiKey } from '../src/lib/crypto.js';
import webpush from 'web-push';

const COUNTRIES = ['MX', 'ES', 'AR', 'CO', 'CL', 'US', 'PE'];
const BROWSERS = ['chrome', 'firefox', 'edge', 'safari', 'samsung'];
const LANGS = ['es', 'es-mx', 'en', 'pt'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

try {
  const org = await one(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) {
    console.error('Crea primero un usuario administrador: npm run create-admin -- --email ...');
    process.exit(1);
  }
  const vapid = webpush.generateVAPIDKeys();
  const app = await one(
    `INSERT INTO apps (org_id, name, slug, site_url, allowed_origins, vapid_public, vapid_private, settings)
     VALUES ($1,'Demo PushFlow','demo-pushflow','https://ejemplo.com','{https://ejemplo.com}',$2,$3,$4)
     ON CONFLICT (org_id, slug) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [org.id, vapid.publicKey, vapid.privateKey,
     { prompt: { type: 'slide', delay_seconds: 3 } }]);

  const apiKey = generateApiKey();
  await query(
    `INSERT INTO api_keys (app_id, name, key_prefix, key_hash) VALUES ($1,'demo',$2,$3)`,
    [app.id, apiKey.prefix, apiKey.hash]);

  const total = Number(process.argv[2]) || 500;
  for (let i = 0; i < total; i++) {
    const isAndroid = Math.random() < 0.35;
    await query(
      `INSERT INTO subscriptions (app_id, channel, endpoint, p256dh, auth_key, fcm_token,
         external_user_id, browser_name, device_os, device_type, country, language,
         timezone_offset, session_count, tags, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               now() - (random()*60 || ' days')::interval,
               now() - (random()*10 || ' days')::interval)`,
      [app.id,
       isAndroid ? 'android' : 'web_push',
       isAndroid ? null : `https://fcm.googleapis.com/fcm/send/demo-${randomUUID()}`,
       isAndroid ? null : 'demo-p256dh-key',
       isAndroid ? null : 'demo-auth-key',
       isAndroid ? `demo-fcm-token-${randomUUID()}` : null,
       Math.random() < 0.6 ? `usuario-${i}` : null,
       isAndroid ? null : pick(BROWSERS),
       isAndroid ? 'android' : null,
       isAndroid ? 'android' : 'desktop',
       pick(COUNTRIES), pick(LANGS),
       pick([-360, -300, -180, 0, 60, 120]),
       Math.floor(Math.random() * 40) + 1,
       { plan: pick(['free', 'pro', 'enterprise']),
         nivel: String(Math.floor(Math.random() * 50)),
         _amount_spent: String((Math.random() * 500).toFixed(2)) }]);
  }

  console.log(`\nApp de demostración creada:`);
  console.log(`  APP_ID:  ${app.id}`);
  console.log(`  API KEY: ${apiKey.key}`);
  console.log(`  ${total} suscripciones simuladas.\n`);
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
