#!/usr/bin/env node
/**
 * Worker de PushFlow.
 *
 * Procesa la cola de trabajos y ejecuta las tareas periódicas. Se pueden
 * levantar varias instancias en paralelo: la cola usa SKIP LOCKED, así que
 * cada trabajo lo toma un único worker.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { pool, query } from '../db/index.js';
import { claim, complete, fail, recoverStale, enqueue } from '../services/queue.js';
import { processDueRuns, runScheduledAutomations, runInactivityAutomations } from '../services/automation.js';
import { mapLimit, sleep } from '../lib/concurrency.js';
import handlers from './handlers.js';
import logger from '../lib/logger.js';

const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
let running = true;
let inFlight = 0;

async function runJob(job) {
  const handler = handlers[job.type];
  if (!handler) {
    logger.error('tipo de trabajo desconocido', { type: job.type, jobId: job.id });
    await fail(job, new Error(`Tipo de trabajo desconocido: ${job.type}`));
    return;
  }
  const started = Date.now();
  try {
    const result = await handler(job.payload || {}, job);
    await complete(job.id);
    logger.debug('trabajo completado', { jobId: job.id, type: job.type, ms: Date.now() - started, result });
  } catch (err) {
    await fail(job, err);
  }
}

/** Bucle principal: reclama trabajos y los ejecuta con concurrencia limitada. */
async function loop() {
  while (running) {
    try {
      const capacity = config.worker.concurrency - inFlight;
      if (capacity <= 0) { await sleep(50); continue; }

      const jobs = await claim(workerId, capacity);
      if (jobs.length === 0) { await sleep(config.worker.pollIntervalMs); continue; }

      inFlight += jobs.length;
      mapLimit(jobs, jobs.length, runJob).finally(() => { inFlight -= jobs.length; });
    } catch (err) {
      logger.error('error en el bucle del worker', { error: err.message });
      await sleep(2000);
    }
  }
}

/** Tareas que se evalúan cada minuto. */
async function minuteTick() {
  try {
    // Notificaciones programadas cuyo momento ya llegó y que no tienen trabajo en cola.
    const { rows } = await query(
      `SELECT id FROM notifications
       WHERE status = 'scheduled' AND send_after <= now() + interval '30 seconds'
       LIMIT 200`);
    for (const row of rows) {
      await query(`UPDATE notifications SET status='queued', queued_at=now() WHERE id=$1`, [row.id]);
      await enqueue('notification.dispatch', { notificationId: row.id },
        { priority: 10, uniqueKey: `dispatch:${row.id}` });
    }
    await processDueRuns();
    await runScheduledAutomations();
  } catch (err) {
    logger.error('fallo en la tarea de cada minuto', { error: err.message });
  }
}

/** Tareas cada 15 minutos. */
async function quarterHourTick() {
  try {
    await recoverStale(15);
    await enqueue('segments.refresh', {}, { priority: 200, uniqueKey: 'segments.refresh' });
  } catch (err) {
    logger.error('fallo en la tarea de 15 minutos', { error: err.message });
  }
}

/** Tareas diarias. */
async function dailyTick() {
  try {
    await enqueue('maintenance.daily', {}, { priority: 250, uniqueKey: 'maintenance.daily' });
    await runInactivityAutomations();
  } catch (err) {
    logger.error('fallo en la tarea diaria', { error: err.message });
  }
}

export async function startWorker() {
  logger.info('worker iniciado', {
    workerId, concurrency: config.worker.concurrency, batchSize: config.worker.batchSize });

  await recoverStale(15);
  const timers = [
    setInterval(minuteTick, 60_000),
    setInterval(quarterHourTick, 15 * 60_000),
    setInterval(dailyTick, 6 * 60 * 60_000),
  ];
  timers.forEach((t) => t.unref?.());

  // Primera pasada inmediata para no esperar al primer intervalo.
  minuteTick();
  dailyTick();

  loop();
  return {
    stop: async () => {
      running = false;
      timers.forEach(clearInterval);
      const deadline = Date.now() + 30000;
      while (inFlight > 0 && Date.now() < deadline) await sleep(200);
    },
  };
}

// Ejecución directa (`npm run worker`)
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const worker = await startWorker();
  const shutdown = async (signal) => {
    logger.info('apagando worker', { signal });
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
