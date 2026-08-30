import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.PUSHFLOW_ENV_FILE || resolve(rootDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const bool = (v, def = false) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, def) => (v === undefined || v === '' ? def : Number.parseInt(v, 10));

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Falta la variable de entorno ${name}. Copia .env.example a .env y complétala.`);
  }
  return v;
}

export const config = {
  rootDir,
  env: process.env.NODE_ENV || 'production',
  isProd: (process.env.NODE_ENV || 'production') === 'production',

  server: {
    host: process.env.HOST || '0.0.0.0',
    port: int(process.env.PORT, 3000),
    publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
    trustProxy: bool(process.env.TRUST_PROXY, true),
    bodyLimit: int(process.env.BODY_LIMIT, 2 * 1024 * 1024),
  },

  db: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST || 'localhost',
    port: int(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || 'pushflow',
    user: process.env.PGUSER || 'pushflow',
    password: process.env.PGPASSWORD,
    max: int(process.env.PG_POOL_MAX, 12),
    ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: false } : false,
    statementTimeoutMs: int(process.env.PG_STATEMENT_TIMEOUT, 30000),
  },

  security: {
    // Clave maestra: cifra credenciales FCM y firma cookies/tokens.
    appSecret: process.env.APP_SECRET || (process.env.NODE_ENV === 'test' ? 'test-secret-please-change-0000000000' : required('APP_SECRET')),
    sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 720),
    apiRateLimit: int(process.env.API_RATE_LIMIT, 600),      // req/min por clave
    publicRateLimit: int(process.env.PUBLIC_RATE_LIMIT, 120), // req/min por IP
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  },

  worker: {
    concurrency: int(process.env.WORKER_CONCURRENCY, 4),
    batchSize: int(process.env.WORKER_BATCH_SIZE, 500),
    pollIntervalMs: int(process.env.WORKER_POLL_MS, 1000),
    // Envíos simultáneos hacia los proveedores (web push / FCM)
    sendConcurrency: int(process.env.SEND_CONCURRENCY, 50),
    inline: bool(process.env.WORKER_INLINE, false), // ejecuta el worker dentro del servidor
  },

  // Iconos por defecto del sistema: se usan cuando la app no define los suyos.
  brand: {
    defaultIcon: process.env.DEFAULT_ICON_PATH || '/brand/icon-192.png',
    defaultBadge: process.env.DEFAULT_BADGE_PATH || '/brand/badge-96.png',
  },

  push: {
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    fcmEndpoint: 'https://fcm.googleapis.com/v1/projects',
    webPushTimeoutMs: int(process.env.WEB_PUSH_TIMEOUT, 10000),
    fcmTimeoutMs: int(process.env.FCM_TIMEOUT, 10000),
  },

  retention: {
    eventsMonths: int(process.env.RETENTION_EVENTS_MONTHS, 13),
    jobsDays: int(process.env.RETENTION_JOBS_DAYS, 7),
  },

  geo: {
    // Cabeceras de geolocalización aportadas por el proxy (Cloudflare / Nginx GeoIP)
    countryHeader: process.env.GEO_COUNTRY_HEADER || 'cf-ipcountry',
    cityHeader: process.env.GEO_CITY_HEADER || 'cf-ipcity',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

export default config;
