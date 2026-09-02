/**
 * Configuracion central. Todo lo sensible viene de variables de entorno
 * (.env en el servidor), nunca del codigo.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');

dotenv.config({ path: path.join(serverRoot, '.env') });

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (isProduction) {
    throw new Error(
      'Falta JWT_SECRET. Define un secreto largo y aleatorio en server/.env antes de arrancar en produccion.'
    );
  }
  // En desarrollo se genera uno efimero: las sesiones caducan al reiniciar.
  jwtSecret = crypto.randomBytes(48).toString('hex');
}

export const config = {
  isProduction,
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR || path.join(serverRoot, 'data'),
  get dbFile() {
    return process.env.DB_FILE || path.join(this.dataDir, 'estadisticas.db');
  },
  get uploadDir() {
    return process.env.UPLOAD_DIR || path.join(this.dataDir, 'uploads');
  },
  webDist: process.env.WEB_DIST || path.join(repoRoot, 'web', 'dist'),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 80),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  publicUrl: process.env.PUBLIC_URL || 'https://estadisticas.honorlab.dev',
  bootstrap: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    displayName: process.env.ADMIN_NAME || 'Administrador',
  },
  keepSourceFiles: bool(process.env.KEEP_SOURCE_FILES, true),
};

export default config;
