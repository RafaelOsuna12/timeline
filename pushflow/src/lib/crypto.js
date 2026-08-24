import {
  randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv,
  createHash, createHmac, createSign,
} from 'node:crypto';
import config from '../config.js';

// ---------------------------------------------------------------------------
// Contraseñas (scrypt: sin dependencias nativas)
// ---------------------------------------------------------------------------
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens y claves de API
// ---------------------------------------------------------------------------
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Genera una clave de API: `pf_<prefijo>_<secreto>`. Solo se muestra una vez. */
export function generateApiKey() {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const key = `pf_${prefix}_${secret}`;
  return { key, prefix, hash: sha256(key) };
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Cifrado simétrico para credenciales sensibles (clave privada FCM)
// ---------------------------------------------------------------------------
const masterKey = () => createHash('sha256').update(config.security.appSecret).digest();

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1') return payload; // valor en claro heredado
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Firma de webhooks (compatible con el estilo `t=...,v1=...` de Stripe)
// ---------------------------------------------------------------------------
export function signWebhook(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// ---------------------------------------------------------------------------
// JWT RS256 — usado para pedir el access token de FCM (OAuth2 service account)
// ---------------------------------------------------------------------------
export function signJwtRS256(payload, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKeyPem, 'base64url')}`;
}

export default {
  hashPassword, verifyPassword, randomToken, sha256, generateApiKey, safeEqual,
  encryptSecret, decryptSecret, signWebhook, signJwtRS256,
};
