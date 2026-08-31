import { badRequest } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\/[^\s]+$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isUrl = (v) => typeof v === 'string' && URL_RE.test(v);

export function requireUuid(value, field) {
  if (!isUuid(value)) throw badRequest(`\`${field}\` debe ser un UUID válido`);
  return value;
}

export function uuidArray(value, field) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  for (const v of arr) if (!isUuid(v)) throw badRequest(`\`${field}\` contiene un UUID inválido: ${v}`);
  return arr;
}

export function requireString(value, field, { max = 5000, min = 1 } = {}) {
  if (typeof value !== 'string' || value.length < min) {
    throw badRequest(`\`${field}\` es obligatorio`);
  }
  if (value.length > max) throw badRequest(`\`${field}\` supera ${max} caracteres`);
  return value;
}

export function optionalUrl(value, field) {
  if (value == null || value === '') return null;
  if (!isUrl(value)) throw badRequest(`\`${field}\` debe ser una URL http(s) válida`);
  return value;
}

/**
 * Normaliza contenido multi-idioma.
 * Acepta un string plano ("Hola") o un mapa {"es":"Hola","en":"Hi"}.
 */
export function localized(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw badRequest(`\`${field}\` es obligatorio`);
    return {};
  }
  if (typeof value === 'string') return { en: value };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [lang, text] of Object.entries(value)) {
      if (typeof text !== 'string') throw badRequest(`\`${field}.${lang}\` debe ser texto`);
      // BCP 47 no distingue mayúsculas: "ES", "es-MX" y "es-mx" son equivalentes.
      const code = lang.toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(code)) {
        throw badRequest(`\`${field}\` usa un código de idioma inválido: ${lang}`);
      }
      out[code] = text;
    }
    if (required && Object.keys(out).length === 0) throw badRequest(`\`${field}\` es obligatorio`);
    return out;
  }
  throw badRequest(`\`${field}\` debe ser texto o un objeto por idioma`);
}

export function clampInt(value, { min, max, def }) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function parseBool(value, def = false) {
  if (value == null) return def;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/** Fecha ISO / epoch / "in 2 hours" hacia Date. */
export function parseWhen(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1));
  const relative = /^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i.exec(String(value).trim());
  if (relative) {
    const units = { minute: 60000, hour: 3600000, day: 86400000 };
    const unit = relative[2].replace(/s$/, '');
    return new Date(Date.now() + Number(relative[1]) * units[unit]);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Fecha inválida: ${value}`);
  return d;
}

/** Recorta strings dentro de un objeto de tags y valida tamaños. */
export function sanitizeTags(tags) {
  if (tags == null) return {};
  if (typeof tags !== 'object' || Array.isArray(tags)) throw badRequest('`tags` debe ser un objeto');
  const out = {};
  const keys = Object.keys(tags);
  if (keys.length > 200) throw badRequest('Máximo 200 tags por suscripción');
  for (const key of keys) {
    if (key.length > 128) throw badRequest(`Clave de tag demasiado larga: ${key}`);
    const value = tags[key];
    if (value === null || value === '') { out[key] = null; continue; } // null = borrar tag
    if (typeof value === 'object') throw badRequest(`El tag \`${key}\` debe ser un valor simple`);
    const str = String(value);
    if (str.length > 1024) throw badRequest(`Valor de tag demasiado largo: ${key}`);
    out[key] = str;
  }
  return out;
}

export default {
  isUuid, isUrl, requireUuid, uuidArray, requireString, optionalUrl, localized,
  clampInt, parseBool, parseWhen, sanitizeTags,
};
