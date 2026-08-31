/**
 * Limpieza de datos de una aplicación.
 *
 * Sirve para dejar una app como recién creada después de las pruebas: borra
 * la analítica, los suscriptores y el historial de campañas, según lo que se
 * pida. Es irreversible, así que la ruta que lo llama exige confirmación
 * escrita y deja constancia en `audit_log`.
 *
 * Nunca toca la configuración de la app: claves VAPID, credenciales de FCM,
 * claves de API, segmentos, plantillas, automatizaciones y webhooks siguen
 * ahí. Si se borrasen, habría que reinstalar el SDK en el sitio del cliente.
 */
import { transaction } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

/**
 * Ámbitos que se pueden limpiar por separado.
 *
 * `suscriptores` arrastra a `estadisticas`: los eventos y las entregas
 * apuntan a los dispositivos, así que conservarlos dejaría una analítica que
 * habla de gente que ya no existe.
 */
export const AMBITOS = {
  estadisticas: {
    etiqueta: 'Estadísticas y eventos',
    descripcion: 'Aperturas, clics, entregas y series por día. Los suscriptores se conservan.',
    implica: [],
  },
  suscriptores: {
    etiqueta: 'Suscriptores registrados',
    descripcion: 'Todos los dispositivos y usuarios. Tendrán que volver a aceptar el permiso.',
    implica: ['estadisticas'],
  },
  notificaciones: {
    etiqueta: 'Historial de notificaciones',
    descripcion: 'Campañas enviadas y programadas, y lo que quede en la cola de envío.',
    implica: [],
  },
};

/** Añade los ámbitos implicados por los que se han pedido. */
export function expandirAmbitos(pedidos) {
  if (!Array.isArray(pedidos) || pedidos.length === 0) {
    throw badRequest('Indica al menos un ámbito que limpiar');
  }
  const fuera = pedidos.filter((a) => !AMBITOS[a]);
  if (fuera.length) throw badRequest(`Ámbito desconocido: ${fuera.join(', ')}`);

  const todos = new Set(pedidos);
  for (const a of pedidos) for (const dep of AMBITOS[a].implica) todos.add(dep);
  return [...todos];
}

/**
 * Borra los datos de la app y devuelve cuántas filas cayó cada tabla.
 * Todo va en una transacción: o se limpia entero o no se toca nada.
 */
export async function limpiarApp(appId, ambitos, contexto = {}) {
  const activos = expandirAmbitos(ambitos);
  const stats = activos.includes('estadisticas');
  const subs = activos.includes('suscriptores');
  const notifs = activos.includes('notificaciones');

  const borrado = {};
  await transaction(async (client) => {
    const del = async (clave, sql, params = [appId]) => {
      const { rowCount } = await client.query(sql, params);
      borrado[clave] = (borrado[clave] || 0) + rowCount;
    };

    // Primero la cola: un envío a medias contra datos que están
    // desapareciendo dejaría entregas sueltas.
    await del('trabajos_en_cola', 'DELETE FROM jobs WHERE app_id = $1');

    if (stats) {
      // `in_app_impressions` se localiza por suscripción, así que hay que
      // vaciarla antes de que desaparezcan las filas de `subscriptions`.
      await del('impresiones', `DELETE FROM in_app_impressions
        WHERE subscription_id IN (SELECT id FROM subscriptions WHERE app_id = $1)`);
      await del('eventos', 'DELETE FROM events WHERE app_id = $1');
      await del('entregas', 'DELETE FROM deliveries WHERE app_id = $1');
      await del('atribuciones', 'DELETE FROM outcome_attributions WHERE app_id = $1');
      await del('series_diarias', 'DELETE FROM daily_stats WHERE app_id = $1');
      await del('series_por_hora', `DELETE FROM notification_stats_hourly
        WHERE notification_id IN (SELECT id FROM notifications WHERE app_id = $1)`);
      await del('contadores_envio', 'DELETE FROM subscription_counters WHERE app_id = $1');
      await del('recorridos', 'DELETE FROM automation_runs WHERE app_id = $1');

      // Los totales que cada notificación lleva cacheados dejarían de
      // cuadrar con unas tablas de eventos ya vacías.
      if (!notifs) {
        await del('campanas_a_cero', `UPDATE notifications
          SET recipients = 0, successful = 0, failed = 0, errored = 0, received = 0,
              clicked = 0, dismissed = 0, converted = 0, updated_at = now()
          WHERE app_id = $1`);
      }
      // El recuento de cada segmento se recalcula solo al abrirlo.
      await del('segmentos_recalculados',
        'UPDATE segments SET cached_count = NULL, cached_at = NULL WHERE app_id = $1');
    }

    if (subs) {
      await del('alias', 'DELETE FROM user_aliases WHERE app_id = $1');
      // Arrastra subscription_counters por clave ajena en cascada.
      await del('suscripciones', 'DELETE FROM subscriptions WHERE app_id = $1');
      await del('usuarios', 'DELETE FROM end_users WHERE app_id = $1');
    }

    if (notifs) {
      await del('exportaciones', 'DELETE FROM exports WHERE app_id = $1');
      // Arrastra notification_stats_hourly en cascada.
      await del('campanas', 'DELETE FROM notifications WHERE app_id = $1');
    }

    // La limpieza sí queda registrada: el historial de administración es lo
    // único que no se borra, justamente para poder responder «¿quién vació esto?».
    await client.query(
      `INSERT INTO audit_log (org_id, app_id, user_id, action, target, metadata, ip)
       VALUES ($1, $2, $3, 'app.reset', $4, $5, $6)`,
      [contexto.orgId || null, appId, contexto.userId || null, appId,
       JSON.stringify({ ambitos: activos, borrado }), contexto.ip || null]);
  });

  logger.warn('datos de la app borrados', { appId, ambitos: activos, borrado,
    userId: contexto.userId });
  return { ambitos: activos, borrado };
}

export default { AMBITOS, expandirAmbitos, limpiarApp };
