/**
 * Almacenamiento de imágenes subidas desde el panel: el icono por defecto de
 * cada app y las imágenes que se adjuntan al redactar una notificación.
 *
 * Los ficheros se guardan fuera del árbol de código, en `data/uploads/<appId>/`,
 * con un nombre generado: nunca se reutiliza el nombre que envía el cliente.
 * El prefijo del nombre distingue quién es dueño del fichero:
 *   `icon-…`   icono por defecto de la app (se sustituye y se limpia solo)
 *   `media-…`  imagen de una notificación (la referencia queda en la campaña,
 *              así que nunca se borra automáticamente)
 */
import { mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import config from '../config.js';
import { badRequest } from '../lib/errors.js';
import { decodificarDataUrl, validarImagen, PERFILES, FORMATOS } from '../lib/images.js';
import { absolutizar } from '../lib/urls.js';
import logger from '../lib/logger.js';

export const UPLOAD_DIR = resolve(config.rootDir, 'data', 'uploads');
export const UPLOAD_PREFIX = '/uploads';
/**
 * Guarda una imagen y devuelve { ruta, url, width, height, format, bytes, aviso }.
 * Valida por bytes, no por la extensión ni por lo que declare el cliente.
 *
 * @param {string} tipo   clave de PERFILES: 'icon' o 'banner'.
 * @param {string} prefijo  prefijo del nombre del fichero (ver cabecera).
 */
export async function guardarImagen(appId, dataUrl, tipo = 'icon', prefijo = 'icon') {
  const perfil = PERFILES[tipo];
  if (!perfil) throw badRequest(`Tipo de imagen desconocido: ${tipo}`);

  const buf = decodificarDataUrl(dataUrl, perfil.maxBytes);
  const info = validarImagen(buf, perfil);

  const dir = resolve(UPLOAD_DIR, appId);
  await mkdir(dir, { recursive: true });

  const nombre = `${prefijo}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
    + `.${FORMATOS[info.format].ext}`;
  await writeFile(resolve(dir, nombre), buf);

  logger.info('imagen subida', {
    appId, nombre, tipo, bytes: buf.length, dimensiones: `${info.width}x${info.height}` });

  // Se guarda la RUTA relativa, no la URL completa: si algún día cambia
  // PUBLIC_URL, las imágenes ya subidas seguirían apuntando al dominio viejo.
  const ruta = `${UPLOAD_PREFIX}/${appId}/${nombre}`;
  return { ...info, bytes: buf.length, ruta, url: absolutizar(ruta) };
}

/** Icono por defecto de la app: el fichero lo gestiona el propio sistema. */
export function guardarIcono(appId, dataUrl) {
  return guardarImagen(appId, dataUrl, 'icon', 'icon');
}

/**
 * Imagen adjunta a una notificación. Se guarda con prefijo `media-` para que
 * la limpieza de iconos no se lleve por delante una imagen que ya está
 * referenciada en una campaña enviada.
 */
export function guardarMedia(appId, dataUrl, tipo) {
  return guardarImagen(appId, dataUrl, tipo, 'media');
}

/**
 * Borra un icono subido a este servidor.
 * Si la URL apunta a otro sitio (o al icono de marca), no hay nada que borrar.
 */
export async function borrarIcono(appId, url) {
  if (!url) return { borrado: false, motivo: 'sin_icono' };

  // Se admiten la ruta relativa actual y las URL absolutas de versiones
  // anteriores, para poder borrar también los iconos ya subidos.
  const prefijoRelativo = `${UPLOAD_PREFIX}/${appId}/`;
  const prefijoAbsoluto = `${config.server.publicUrl}${prefijoRelativo}`;
  let resto;
  if (url.startsWith(prefijoRelativo)) resto = url.slice(prefijoRelativo.length);
  else if (url.startsWith(prefijoAbsoluto)) resto = url.slice(prefijoAbsoluto.length);
  else return { borrado: false, motivo: 'externo' };   // era una URL ajena

  // basename descarta cualquier intento de recorrido de directorios.
  const nombre = basename(resto);
  if (!/^icon-[a-z0-9-]+\.(png|jpg|webp)$/i.test(nombre)) {
    return { borrado: false, motivo: 'nombre_invalido' };
  }
  const ruta = resolve(UPLOAD_DIR, appId, nombre);
  if (!ruta.startsWith(resolve(UPLOAD_DIR, appId))) {
    return { borrado: false, motivo: 'fuera_de_ruta' };
  }
  if (!existsSync(ruta)) return { borrado: false, motivo: 'no_existe' };

  await unlink(ruta);
  logger.info('icono borrado', { appId, nombre });
  return { borrado: true, nombre };
}

/** Elimina iconos huérfanos de una app, conservando el que esté en uso. */
export async function limpiarAntiguos(appId, urlEnUso) {
  const dir = resolve(UPLOAD_DIR, appId);
  if (!existsSync(dir)) return 0;
  const enUso = urlEnUso ? basename(urlEnUso) : null;
  let borrados = 0;
  for (const f of await readdir(dir)) {
    if (f !== enUso && /^icon-/.test(f)) {
      await unlink(resolve(dir, f)).catch(() => {});
      borrados++;
    }
  }
  return borrados;
}

export default {
  guardarImagen, guardarIcono, guardarMedia, borrarIcono, limpiarAntiguos,
  UPLOAD_DIR, UPLOAD_PREFIX,
};
