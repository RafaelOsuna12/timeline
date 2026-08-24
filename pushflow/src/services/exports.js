/**
 * Exportación de datos a CSV (suscripciones, notificaciones, eventos, entregas).
 * Se genera en streaming con un cursor para no cargar todo en memoria.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../config.js';
import { pool, one, query } from '../db/index.js';
import logger from '../lib/logger.js';

const EXPORT_DIR = resolve(config.rootDir, 'data', 'exports');

const QUERIES = {
  subscriptions: {
    columns: ['id', 'channel', 'external_user_id', 'device_type', 'browser_name', 'device_os',
              'os_version', 'country', 'region', 'city', 'language', 'timezone', 'subscribed',
              'invalid', 'session_count', 'tags', 'created_at', 'last_seen_at'],
    sql: (where) => `SELECT * FROM subscriptions WHERE app_id = $1 ${where} ORDER BY created_at DESC`,
  },
  notifications: {
    columns: ['id', 'name', 'headings', 'contents', 'status', 'recipients', 'successful', 'failed',
              'received', 'clicked', 'dismissed', 'converted', 'created_at', 'completed_at'],
    sql: (where) => `SELECT * FROM notifications WHERE app_id = $1 ${where} ORDER BY created_at DESC`,
  },
  deliveries: {
    columns: ['id', 'notification_id', 'subscription_id', 'channel', 'variant', 'status',
              'error_code', 'sent_at', 'delivered_at', 'clicked_at', 'created_at'],
    sql: (where) => `SELECT * FROM deliveries WHERE app_id = $1 ${where} ORDER BY created_at DESC`,
  },
  events: {
    columns: ['id', 'type', 'name', 'value', 'subscription_id', 'notification_id', 'channel',
              'country', 'browser_name', 'os', 'url', 'action_id', 'created_at'],
    sql: (where) => `SELECT * FROM events WHERE app_id = $1 ${where} ORDER BY created_at DESC`,
  },
};

const escapeCsv = (value) => {
  if (value == null) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

export async function createExport(appId, kind, params = {}, createdBy = null) {
  if (!QUERIES[kind]) throw new Error(`Tipo de exportación no soportado: ${kind}`);
  const row = await one(
    `INSERT INTO exports (app_id, kind, params, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [appId, kind, params, createdBy]);
  const { enqueue } = await import('./queue.js');
  await enqueue('export.run', { exportId: row.id }, { appId, priority: 180 });
  return row;
}

export async function runExport(exportId) {
  const job = await one('SELECT * FROM exports WHERE id = $1', [exportId]);
  if (!job) return { skipped: true };
  await query(`UPDATE exports SET status='running' WHERE id=$1`, [exportId]);

  const spec = QUERIES[job.kind];
  mkdirSync(EXPORT_DIR, { recursive: true });
  const filePath = resolve(EXPORT_DIR, `${job.kind}-${exportId}.csv`);

  const values = [job.app_id];
  let where = '';
  if (job.params.from) { values.push(job.params.from); where += ` AND created_at >= $${values.length}`; }
  if (job.params.to) { values.push(job.params.to); where += ` AND created_at <= $${values.length}`; }
  if (job.kind === 'subscriptions' && job.params.only_active) {
    where += ' AND subscribed AND NOT invalid AND NOT opted_out';
  }
  if (job.kind === 'events' && job.params.type) {
    values.push(job.params.type); where += ` AND type = $${values.length}`;
  }

  const client = await pool.connect();
  const out = createWriteStream(filePath, { encoding: 'utf8' });
  let rows = 0;
  try {
    out.write(`${spec.columns.join(',')}\n`);
    // Cursor por lotes: evita traer millones de filas de golpe.
    await client.query('BEGIN');
    await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR ${spec.sql(where)}`, values);
    for (;;) {
      const { rows: batch } = await client.query('FETCH 2000 FROM export_cursor');
      if (batch.length === 0) break;
      for (const row of batch) {
        out.write(`${spec.columns.map((c) => escapeCsv(row[c])).join(',')}\n`);
      }
      rows += batch.length;
    }
    await client.query('CLOSE export_cursor');
    await client.query('COMMIT');
    out.end();
    await new Promise((res, rej) => { out.on('close', res); out.on('error', rej); });

    await query(
      `UPDATE exports SET status='done', file_path=$2, rows=$3, completed_at=now() WHERE id=$1`,
      [exportId, filePath, rows]);
    logger.info('exportación completada', { exportId, kind: job.kind, rows });
    return { rows, filePath };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    out.destroy();
    await query(`UPDATE exports SET status='failed', error=$2 WHERE id=$1`, [exportId, err.message]);
    throw err;
  } finally {
    client.release();
  }
}

export { EXPORT_DIR };
export default { createExport, runExport, EXPORT_DIR };
