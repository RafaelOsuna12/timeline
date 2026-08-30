import config from '../config.js';

/**
 * Convierte una ruta interna (`/uploads/...`, `/brand/...`) en URL absoluta.
 * Las URL que ya son absolutas se devuelven tal cual: el icono de una app
 * puede apuntar a un servidor ajeno.
 *
 * Guardar rutas relativas y resolverlas aquí evita que cambiar PUBLIC_URL
 * deje apuntando a un dominio antiguo todo lo subido hasta entonces.
 */
export function absolutizar(valor) {
  if (!valor) return null;
  if (/^https?:\/\//i.test(valor)) return valor;
  return `${config.server.publicUrl}${valor.startsWith('/') ? '' : '/'}${valor}`;
}

export default { absolutizar };
