/**
 * Automatizaciones (journeys): secuencias disparadas por eventos.
 *
 * Trigger:
 *   {"type":"subscription_created"}                  → alta de un dispositivo
 *   {"type":"event","event_name":"carrito_abandonado"}
 *   {"type":"tag_changed","key":"plan"}
 *   {"type":"inactivity","inactive_days":7}
 *   {"type":"schedule","cron":"0 9 * * 1"}
 *
 * Pasos:
 *   {"type":"wait","minutes":60}
 *   {"type":"send","payload":{ ...cuerpo de notificación... }}
 *   {"type":"condition","filters":[...]}   → si no cumple, termina el recorrido
 *   {"type":"tag","tags":{"estado":"contactado"}}
 */
import { one, many, query } from '../db/index.js';
import { subscriptionMatches } from './audience.js';
import { createNotification } from './notifications.js';
import { updateSubscription } from './subscriptions.js';
import { cronMatches } from '../lib/cron.js';
import { enqueue } from './queue.js';
import logger from '../lib/logger.js';

/** Inicia recorridos para las automatizaciones que respondan a este evento. */
export async function handleTrigger({ appId, event, subscriptionId, eventName = null }) {
  const automations = await many(
    `SELECT * FROM automations
     WHERE app_id = $1 AND status = 'active' AND trigger->>'type' = $2`,
    [appId, event]);

  let started = 0;
  for (const automation of automations) {
    if (event === 'event' && automation.trigger.event_name !== eventName) continue;
    if (automation.segment_id) {
      const segment = await one('SELECT filters FROM segments WHERE id = $1', [automation.segment_id]);
      if (segment && !(await subscriptionMatches(appId, subscriptionId, segment.filters))) continue;
    }
    if (!automation.reentry) {
      const previous = await one(
        `SELECT 1 AS x FROM automation_runs
         WHERE automation_id = $1 AND subscription_id = $2 LIMIT 1`,
        [automation.id, subscriptionId]);
      if (previous) continue;
    }
    const run = await one(
      `INSERT INTO automation_runs (automation_id, app_id, subscription_id, next_run_at, context)
       VALUES ($1,$2,$3, now(), $4)
       ON CONFLICT (automation_id, subscription_id) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [automation.id, appId, subscriptionId, { event, eventName }]);
    if (run) started++;
  }
  if (started) logger.info('automatizaciones iniciadas', { appId, event, started });
  return started;
}

/** Ejecuta un paso de cada recorrido vencido. Lo llama el worker cada minuto. */
export async function processDueRuns(limit = 200) {
  const runs = await many(
    `SELECT r.*, a.steps, a.status AS automation_status
     FROM automation_runs r
     JOIN automations a ON a.id = r.automation_id
     WHERE r.status = 'active' AND r.next_run_at <= now() AND a.status = 'active'
     ORDER BY r.next_run_at ASC LIMIT $1`, [limit]);

  let processed = 0;
  for (const run of runs) {
    try { await processRun(run); processed++; } catch (err) {
      logger.error('paso de automatización fallido', { runId: run.id, error: err.message });
      await query(
        `UPDATE automation_runs SET status='failed', context = context || $2::jsonb, updated_at=now()
         WHERE id=$1`, [run.id, { error: err.message }]);
    }
  }
  return processed;
}

async function processRun(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  if (run.step_index >= steps.length) return finishRun(run.id, 'completed');

  const step = steps[run.step_index];
  const subscription = await one(
    'SELECT * FROM subscriptions WHERE id = $1 AND subscribed AND NOT invalid',
    [run.subscription_id]);
  if (!subscription) return finishRun(run.id, 'canceled');

  switch (step.type) {
    case 'wait': {
      const minutes = Number(step.minutes ?? step.hours * 60 ?? 60) || 60;
      return query(
        `UPDATE automation_runs SET step_index = step_index + 1,
                next_run_at = now() + ($2 || ' minutes')::interval, updated_at = now()
         WHERE id = $1`, [run.id, minutes]);
    }
    case 'condition': {
      const ok = await subscriptionMatches(run.app_id, run.subscription_id, step.filters || []);
      if (!ok) return finishRun(run.id, 'completed');
      return advance(run.id);
    }
    case 'tag': {
      await updateSubscription(run.app_id, run.subscription_id, { tags: step.tags || {} });
      return advance(run.id);
    }
    case 'send': {
      const app = await one('SELECT * FROM apps WHERE id = $1', [run.app_id]);
      await createNotification(app, {
        ...step.payload,
        include_subscription_ids: [run.subscription_id],
        name: step.payload?.name || `automatización:${run.automation_id}`,
      }, { source: 'automation' });
      await query(
        `UPDATE automations SET stats = jsonb_set(stats, '{sent}',
           to_jsonb(COALESCE((stats->>'sent')::bigint, 0) + 1)) WHERE id = $1`,
        [run.automation_id]);
      return advance(run.id);
    }
    default:
      logger.warn('paso de automatización desconocido', { type: step.type, runId: run.id });
      return advance(run.id);
  }
}

const advance = (runId) => query(
  `UPDATE automation_runs SET step_index = step_index + 1, next_run_at = now(), updated_at = now()
   WHERE id = $1`, [runId]);

const finishRun = (runId, status) => query(
  `UPDATE automation_runs SET status = $2, next_run_at = NULL, updated_at = now() WHERE id = $1`,
  [runId, status]);

/** Automatizaciones con trigger `schedule`: se evalúan una vez por minuto. */
export async function runScheduledAutomations(now = new Date()) {
  const automations = await many(
    `SELECT * FROM automations WHERE status = 'active' AND trigger->>'type' = 'schedule'`);
  let fired = 0;
  for (const automation of automations) {
    const cron = automation.trigger.cron;
    if (!cron || !cronMatches(cron, now)) continue;

    const app = await one('SELECT * FROM apps WHERE id = $1', [automation.app_id]);
    const sendStep = (automation.steps || []).find((s) => s.type === 'send');
    if (!app || !sendStep) continue;

    await createNotification(app, {
      ...sendStep.payload,
      ...(automation.segment_id ? { included_segments: [automation.segment_id] } : {}),
      name: sendStep.payload?.name || `programada:${automation.name}`,
    }, { source: 'automation' });
    fired++;
  }
  if (fired) logger.info('automatizaciones programadas lanzadas', { fired });
  return fired;
}

/** Trigger por inactividad: se evalúa una vez al día. */
export async function runInactivityAutomations() {
  const automations = await many(
    `SELECT * FROM automations WHERE status = 'active' AND trigger->>'type' = 'inactivity'`);
  let started = 0;
  for (const automation of automations) {
    const days = Number(automation.trigger.inactive_days || 7);
    const candidates = await many(
      `SELECT s.id FROM subscriptions s
       WHERE s.app_id = $1 AND s.subscribed AND NOT s.invalid AND NOT s.opted_out
         AND s.last_seen_at < now() - ($2 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.automation_id = $3 AND r.subscription_id = s.id
             AND r.created_at > now() - ($2 || ' days')::interval)
       LIMIT 5000`, [automation.app_id, days, automation.id]);
    for (const candidate of candidates) {
      await enqueue('automation.trigger', {
        appId: automation.app_id, event: 'inactivity', subscriptionId: candidate.id,
      }, { appId: automation.app_id, priority: 120 });
      started++;
    }
  }
  return started;
}

export default { handleTrigger, processDueRuns, runScheduledAutomations, runInactivityAutomations };
