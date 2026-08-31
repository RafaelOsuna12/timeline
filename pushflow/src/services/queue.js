/**
 * Cola de trabajos sobre PostgreSQL.
 *
 * Usa `FOR UPDATE SKIP LOCKED`, así varios workers pueden competir por la misma
 * cola sin bloquearse y sin necesidad de Redis ni de otro servicio externo.
 */
import { one, many, query } from '../db/index.js';
import logger from '../lib/logger.js';

/** Espera exponencial con tope de 1 h: 10s, 40s, 90s, 160s, ... */
const backoffSeconds = (attempts) => Math.min(3600, 10 * attempts ** 2);

/**
 * Encola un trabajo.
 * `uniqueKey` evita duplicados mientras el trabajo siga pendiente o en curso.
 */
export async function enqueue(type, payload = {}, opts = {}) {
  const row = await one(
    `INSERT INTO jobs (app_id, type, payload, priority, run_at, max_attempts, unique_key)
     VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6,$7)
     ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending','running')
     DO NOTHING
     RETURNING id`,
    [
      opts.appId || null,
      type,
      payload,
      opts.priority ?? 100,
      opts.runAt || null,
      opts.maxAttempts ?? 5,
      opts.uniqueKey || null,
    ]);
  return row?.id || null;
}

/** Toma hasta `limit` trabajos listos y los marca como `running`. */
export async function claim(workerId, limit = 1) {
  return many(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(),
                     attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY priority ASC, run_at ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, app_id, type, payload, attempts, max_attempts`,
    [workerId, limit]);
}

export async function complete(jobId) {
  await query(`UPDATE jobs SET status='done', locked_by=NULL, updated_at=now() WHERE id=$1`, [jobId]);
}

/** Marca el fallo y reprograma con backoff, o lo da por perdido. */
export async function fail(job, error) {
  const message = String(error?.stack || error?.message || error).slice(0, 2000);
  if (job.attempts >= job.max_attempts) {
    await query(
      `UPDATE jobs SET status='failed', last_error=$2, locked_by=NULL, updated_at=now() WHERE id=$1`,
      [job.id, message]);
    logger.error('trabajo agotado tras reintentos', { jobId: job.id, type: job.type, error: message });
    return false;
  }
  await query(
    `UPDATE jobs SET status='pending', last_error=$2, locked_by=NULL,
                     run_at = now() + ($3 || ' seconds')::interval, updated_at=now()
     WHERE id=$1`,
    [job.id, message, backoffSeconds(job.attempts)]);
  logger.warn('trabajo reprogramado', {
    jobId: job.id, type: job.type, attempt: job.attempts, retryInSec: backoffSeconds(job.attempts),
  });
  return true;
}

/** Reencola trabajos cuyo worker murió sin liberarlos. */
export async function recoverStale(olderThanMinutes = 15) {
  const { rowCount } = await query(
    `UPDATE jobs SET status='pending', locked_by=NULL, locked_at=NULL, updated_at=now()
     WHERE status='running' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [olderThanMinutes]);
  if (rowCount) logger.warn('trabajos huérfanos recuperados', { count: rowCount });
  return rowCount;
}

export async function cancelByUniqueKey(uniqueKey) {
  const { rowCount } = await query(
    `UPDATE jobs SET status='canceled', updated_at=now()
     WHERE unique_key=$1 AND status IN ('pending','running')`, [uniqueKey]);
  return rowCount;
}

export async function purgeCompleted(days = 7) {
  const { rowCount } = await query(
    `DELETE FROM jobs WHERE status IN ('done','canceled')
     AND updated_at < now() - ($1 || ' days')::interval`, [days]);
  return rowCount;
}

export async function stats() {
  return many(`SELECT status, type, count(*)::int AS n FROM jobs GROUP BY status, type ORDER BY n DESC`);
}

export default { enqueue, claim, complete, fail, recoverStale, cancelByUniqueKey, purgeCompleted, stats };
