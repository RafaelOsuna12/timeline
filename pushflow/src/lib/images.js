/**
 * Inspección de imágenes sin dependencias.
 *
 * Lee las cabeceras binarias para averiguar formato y dimensiones. Nunca se
 * confía en la extensión ni en el `content-type` que declare el cliente: un
 * fichero se acepta solo si sus bytes iniciales corresponden al formato.
 */
import { badRequest } from './errors.js';

/** Formatos admitidos como icono. SVG queda fuera a propósito (ver README). */
export const FORMATOS = {
  png:  { mime: 'image/png',  ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

const firma = (buf, bytes, offset = 0) =>
  bytes.every((b, i) => buf[offset + i] === b);

/** PNG: la cabecera IHDR trae ancho y alto como uint32 big-endian. */
function leerPng(buf) {
  if (!firma(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw badRequest('El PNG está corrupto: falta la cabecera IHDR');
  }
  return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** JPEG: hay que recorrer los segmentos hasta encontrar un marcador SOF. */
function leerJpeg(buf) {
  if (!firma(buf, [0xff, 0xd8])) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marcador = buf[i + 1];
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 llevan las dimensiones.
    const esSof = (marcador >= 0xc0 && marcador <= 0xcf)
      && ![0xc4, 0xc8, 0xcc].includes(marcador);
    if (esSof) {
      return { format: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const longitud = buf.readUInt16BE(i + 2);
    if (longitud < 2) break;
    i += 2 + longitud;
  }
  throw badRequest('El JPEG está corrupto: no se encontró el marcador de dimensiones');
}

/** WebP: contenedor RIFF con variantes VP8 (lossy), VP8L (lossless) y VP8X. */
function leerWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const ancho = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const alto = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { format: 'webp', width: ancho, height: alto };
  }
  throw badRequest('WebP con un formato interno no reconocido');
}

/** Devuelve { format, width, height } o lanza si no es una imagen admitida. */
export function inspeccionar(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    throw badRequest('El fichero está vacío o es demasiado pequeño para ser una imagen');
  }
  const resultado = leerPng(buf) || leerJpeg(buf) || leerWebp(buf);
  if (!resultado) {
    throw badRequest('Formato no admitido. Sube un PNG, JPEG o WebP.');
  }
  if (!resultado.width || !resultado.height) {
    throw badRequest('No se pudieron leer las dimensiones de la imagen');
  }
  return resultado;
}

/**
 * Decodifica un data URL (`data:image/png;base64,...`).
 * El panel envía las imágenes así para no añadir una dependencia de multipart.
 */
export function decodificarDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== 'string') throw badRequest('Falta la imagen');
  const m = /^data:([\w.+-]+\/[\w.+-]+)?;base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!m) throw badRequest('La imagen debe llegar como data URL en base64');

  // base64 abulta ~4/3: se comprueba antes de reservar el buffer.
  const aprox = Math.floor(m[2].length * 3 / 4);
  if (maxBytes && aprox > maxBytes) {
    throw badRequest(`La imagen supera el máximo de ${Math.round(maxBytes / 1024)} KB`);
  }
  const buf = Buffer.from(m[2], 'base64');
  if (maxBytes && buf.length > maxBytes) {
    throw badRequest(`La imagen supera el máximo de ${Math.round(maxBytes / 1024)} KB`);
  }
  return buf;
}

/** Comprobaciones propias de un icono de notificación. */
export function validarIcono(buf, { min = 64, max = 2048 } = {}) {
  const info = inspeccionar(buf);
  if (info.width < min || info.height < min) {
    throw badRequest(
      `El icono es demasiado pequeño (${info.width}×${info.height}). Mínimo ${min}×${min} px.`);
  }
  if (info.width > max || info.height > max) {
    throw badRequest(`El icono es demasiado grande (${info.width}×${info.height}). Máximo ${max}×${max} px.`);
  }
  // No es motivo de rechazo, pero el panel lo advierte: los sistemas recortan
  // los iconos en cuadrado o círculo y una imagen alargada se ve mal.
  const proporcion = info.width / info.height;
  info.cuadrada = proporcion > 0.95 && proporcion < 1.05;
  return info;
}

export default { inspeccionar, decodificarDataUrl, validarIcono, FORMATOS };
