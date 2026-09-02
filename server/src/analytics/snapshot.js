/**
 * Carga de snapshots desde SQLite a memoria.
 *
 * Un snapshot completo son ~200 promotores x 31 dias: cabe de sobra en RAM y
 * permite construir cualquier corte del dashboard sin volver a la base. Se
 * mantiene una cache pequeña con los ultimos snapshots consultados.
 */
import { db } from '../db.js';
import { zeros } from './metrics.js';

const CACHE_LIMIT = 4;
const cache = new Map();

export function invalidateCache(snapshotId) {
  if (snapshotId === undefined) cache.clear();
  else cache.delete(Number(snapshotId));
}

/** Metadatos de todos los snapshots, mas reciente primero. */
export function listSnapshots() {
  const rows = db
    .prepare(
      `SELECT id, period_key, period_year, period_month, days_in_month, cutoff_day, cutoff_date,
              source_name, uploaded_by, created_at, status, meta_json
         FROM snapshots
        ORDER BY period_key DESC, cutoff_day DESC, created_at DESC`
    )
    .all();
  return rows.map(hydrateMeta);
}

function hydrateMeta(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.meta_json || '{}');
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    periodKey: row.period_key,
    periodYear: row.period_year,
    periodMonth: row.period_month,
    daysInMonth: row.days_in_month,
    cutoffDay: row.cutoff_day,
    cutoffDate: row.cutoff_date,
    sourceName: row.source_name,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    status: row.status,
    warnings: meta.warnings || [],
    modelNames: meta.modelNames || [],
    promoterCount: meta.promoterCount ?? null,
    leaderCount: meta.leaderCount ?? null,
  };
}

/** Snapshot vigente: el de corte mas avanzado del periodo mas reciente. */
export function currentSnapshotId(periodKey) {
  const row = periodKey
    ? db
        .prepare(
          `SELECT id FROM snapshots WHERE period_key = ?
            ORDER BY cutoff_day DESC, created_at DESC LIMIT 1`
        )
        .get(periodKey)
    : db
        .prepare(
          `SELECT id FROM snapshots
            ORDER BY period_key DESC, cutoff_day DESC, created_at DESC LIMIT 1`
        )
        .get();
  return row ? row.id : null;
}

/** Snapshot inmediatamente anterior al dado dentro del mismo periodo. */
export function previousSnapshotId(snapshotId) {
  const cur = db.prepare('SELECT period_key, cutoff_day, created_at FROM snapshots WHERE id = ?').get(snapshotId);
  if (!cur) return null;
  const row = db
    .prepare(
      `SELECT id FROM snapshots
        WHERE period_key = ?
          AND (cutoff_day < ? OR (cutoff_day = ? AND created_at < ?))
        ORDER BY cutoff_day DESC, created_at DESC LIMIT 1`
    )
    .get(cur.period_key, cur.cutoff_day, cur.cutoff_day, cur.created_at);
  return row ? row.id : null;
}

/**
 * Carga completa de un snapshot.
 * @returns {{meta:object, promoters:Array, leaders:Array, modelChannel:Array, variants:Array}}
 */
export function loadSnapshot(snapshotId) {
  const id = Number(snapshotId);
  if (cache.has(id)) return cache.get(id);

  const metaRow = db
    .prepare(
      `SELECT id, period_key, period_year, period_month, days_in_month, cutoff_day, cutoff_date,
              source_name, uploaded_by, created_at, status, meta_json
         FROM snapshots WHERE id = ?`
    )
    .get(id);
  if (!metaRow) return null;
  const meta = hydrateMeta(metaRow);
  const days = meta.daysInMonth;

  const promoterRows = db.prepare('SELECT * FROM promoters WHERE snapshot_id = ?').all(id);
  const promoters = new Map();
  for (const r of promoterRows) {
    let models = {};
    try {
      models = JSON.parse(r.models_json || '{}');
    } catch {
      models = {};
    }
    promoters.set(r.promoter_id, {
      id: r.promoter_id,
      advisor: r.advisor,
      channel: r.channel,
      region: r.region,
      store: r.store,
      supervisor: r.supervisor,
      cm: r.cm,
      status: r.status,
      targetInitial: r.target_initial,
      targetAdjusted: r.target_adjusted,
      targetHQ: r.target_hq,
      models,
      modelDaily: {},
      daily: {
        soTarget: zeros(days),
        soAll: zeros(days),
        soIot: zeros(days),
        attendance: zeros(days),
        zeroSale: zeros(days),
      },
    });
  }

  for (const d of db.prepare('SELECT * FROM promoter_daily WHERE snapshot_id = ?').iterate(id)) {
    const p = promoters.get(d.promoter_id);
    if (!p || d.day < 1 || d.day > days) continue;
    const i = d.day - 1;
    p.daily.soTarget[i] = d.so_target;
    p.daily.soAll[i] = d.so_all;
    p.daily.soIot[i] = d.so_iot;
    p.daily.attendance[i] = d.attendance;
    p.daily.zeroSale[i] = d.zero_sale;
  }

  for (const d of db.prepare('SELECT * FROM promoter_model_daily WHERE snapshot_id = ?').iterate(id)) {
    const p = promoters.get(d.promoter_id);
    if (!p || d.day < 1 || d.day > days) continue;
    if (!p.modelDaily[d.model]) p.modelDaily[d.model] = zeros(days);
    p.modelDaily[d.model][d.day - 1] = d.qty;
  }

  const leaderRows = db.prepare('SELECT * FROM leaders WHERE snapshot_id = ?').all(id);
  const leaders = new Map();
  for (const r of leaderRows) {
    let models = {};
    try {
      models = JSON.parse(r.models_json || '{}');
    } catch {
      models = {};
    }
    leaders.set(r.leader_id, {
      id: r.leader_id,
      name: r.name,
      position: r.position,
      region: r.region,
      cm: r.cm,
      ffsInCharge: r.ffs_in_charge,
      targetHQ: r.target_hq,
      soXls: r.so,
      soAllXls: r.so_all,
      models,
      daily: { so: zeros(days), attendance: zeros(days), zeroSaleFF: zeros(days) },
    });
  }
  for (const d of db.prepare('SELECT * FROM leader_daily WHERE snapshot_id = ?').iterate(id)) {
    const l = leaders.get(d.leader_id);
    if (!l || d.day < 1 || d.day > days) continue;
    l.daily.so[d.day - 1] = d.so;
    l.daily.attendance[d.day - 1] = d.attendance;
    l.daily.zeroSaleFF[d.day - 1] = d.zero_sale_ff;
  }

  const modelChannel = db
    .prepare('SELECT * FROM model_channel WHERE snapshot_id = ?')
    .all(id)
    .map((r) => ({
      channel: r.channel,
      model: r.model,
      stores: r.stores,
      so: r.so,
      productivity: r.productivity,
      daily: safeJson(r.daily_json, []),
    }));

  const variants = db
    .prepare('SELECT * FROM model_variants WHERE snapshot_id = ?')
    .all(id)
    .map((r) => ({
      sheet: r.sheet,
      model: r.model,
      dimension: r.dimension,
      channel: r.channel,
      variant: r.variant,
      so: r.so,
      daily: safeJson(r.daily_json, []),
    }));

  const snapshot = {
    meta,
    promoters: [...promoters.values()],
    leaders: [...leaders.values()],
    modelChannel,
    variants,
  };

  cache.set(id, snapshot);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return snapshot;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
