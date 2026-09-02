/**
 * Persistencia de un dataset parseado como snapshot.
 *
 * Regla de negocio: para un mismo periodo (YYYY-MM) puede haber muchos
 * snapshots, uno por actualizacion diaria del archivo. El snapshot vigente de
 * un periodo es el de mayor `cutoff_day`; a igualdad, el mas reciente.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, audit } from './db.js';

const sum = (arr) => (arr || []).reduce((a, b) => a + (b || 0), 0);

export function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Inserta el dataset como un nuevo snapshot y devuelve su id.
 * Toda la escritura ocurre en una transaccion: o entra completo o no entra.
 */
export function saveSnapshot(dataset, { storedFile = null, hash = null, uploadedBy = null } = {}) {
  const { meta } = dataset;

  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots
      (period_key, period_year, period_month, days_in_month, cutoff_day, cutoff_date,
       source_name, stored_file, file_hash, uploaded_by, created_at, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const insPromoter = db.prepare(`
    INSERT INTO promoters
      (snapshot_id, promoter_id, advisor, channel, region, store, supervisor, cm, status,
       target_initial, target_adjusted, target_hq, so_target, so_all, so_iot,
       attendance_days, zero_sale_days, models_json)
    VALUES (@snapshot_id,@promoter_id,@advisor,@channel,@region,@store,@supervisor,@cm,@status,
            @target_initial,@target_adjusted,@target_hq,@so_target,@so_all,@so_iot,
            @attendance_days,@zero_sale_days,@models_json)
  `);

  const insPromoterDay = db.prepare(`
    INSERT INTO promoter_daily (snapshot_id, promoter_id, day, so_target, so_all, so_iot, attendance, zero_sale)
    VALUES (?,?,?,?,?,?,?,?)
  `);

  const insModelDay = db.prepare(`
    INSERT INTO promoter_model_daily (snapshot_id, promoter_id, model, day, qty)
    VALUES (?,?,?,?,?)
    ON CONFLICT(snapshot_id, promoter_id, model, day) DO UPDATE SET qty = qty + excluded.qty
  `);

  const insLeader = db.prepare(`
    INSERT INTO leaders (snapshot_id, leader_id, name, position, region, cm, ffs_in_charge, target_hq, so, so_all, models_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insLeaderDay = db.prepare(`
    INSERT INTO leader_daily (snapshot_id, leader_id, day, so, attendance, zero_sale_ff)
    VALUES (?,?,?,?,?,?)
  `);
  const insModelChannel = db.prepare(`
    INSERT INTO model_channel (snapshot_id, channel, model, stores, so, productivity, daily_json)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_id, channel, model) DO NOTHING
  `);
  const insVariant = db.prepare(`
    INSERT INTO model_variants (snapshot_id, sheet, model, dimension, channel, variant, so, daily_json)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_id, sheet, dimension, channel, variant) DO NOTHING
  `);

  const run = db.transaction(() => {
    const info = insertSnapshot.run(
      meta.periodKey,
      meta.periodYear,
      meta.periodMonth,
      meta.daysInMonth,
      meta.cutoffDay,
      meta.cutoffDate,
      meta.sourceName,
      storedFile,
      hash,
      uploadedBy,
      new Date().toISOString(),
      'ready',
      JSON.stringify({
        warnings: meta.warnings || [],
        sheetNames: meta.sheetNames || [],
        modelNames: meta.modelNames || [],
        parsedAt: meta.parsedAt,
        promoterCount: dataset.promoters.length,
        leaderCount: dataset.supervisors.length,
      })
    );
    const snapshotId = info.lastInsertRowid;

    for (const p of dataset.promoters) {
      insPromoter.run({
        snapshot_id: snapshotId,
        promoter_id: p.id,
        advisor: p.advisor,
        channel: p.channel,
        region: p.region,
        store: p.store,
        supervisor: p.supervisor,
        cm: p.cm,
        status: p.status,
        target_initial: p.targetInitial,
        target_adjusted: p.targetAdjusted,
        target_hq: p.targetHQ,
        so_target: p.soTargetModels ?? sum(p.daily.soTarget),
        so_all: p.soAllModels ?? sum(p.daily.soAll),
        so_iot: sum(p.daily.iot),
        attendance_days: sum(p.daily.attendance),
        zero_sale_days: sum(p.daily.zeroSale),
        models_json: JSON.stringify(p.models || {}),
      });
      const days = meta.daysInMonth;
      for (let d = 0; d < days; d += 1) {
        const soT = p.daily.soTarget[d] || 0;
        const soA = p.daily.soAll[d] || 0;
        const iot = p.daily.iot?.[d] || 0;
        const att = p.daily.attendance[d] || 0;
        const zero = p.daily.zeroSale[d] || 0;
        if (!soT && !soA && !iot && !att && !zero) continue;
        insPromoterDay.run(snapshotId, p.id, d + 1, soT, soA, iot, att, zero);
      }
    }

    for (const md of dataset.modelDaily || []) {
      for (const [promoterId, series] of md.byId) {
        for (let d = 0; d < series.length; d += 1) {
          if (!series[d]) continue;
          insModelDay.run(snapshotId, promoterId, md.model, d + 1, series[d]);
        }
      }
    }

    for (const l of dataset.supervisors) {
      const leaderId = `${l.position}||${l.nameKey}`;
      insLeader.run(
        snapshotId,
        leaderId,
        l.name,
        l.position,
        l.region,
        l.cm,
        l.ffsInCharge,
        l.targetHQ,
        sum(l.daily.so),
        l.soAllModels,
        JSON.stringify(l.models || {})
      );
      for (let d = 0; d < meta.daysInMonth; d += 1) {
        const so = l.daily.so[d] || 0;
        const att = l.daily.attendance?.[d] || 0;
        const zero = l.daily.zeroSaleFF?.[d] || 0;
        if (!so && !att && !zero) continue;
        insLeaderDay.run(snapshotId, leaderId, d + 1, so, att, zero);
      }
    }

    for (const r of dataset.soModel || []) {
      insModelChannel.run(snapshotId, r.channel, r.model, r.stores, r.so, r.productivity, JSON.stringify(r.daily));
    }

    for (const v of dataset.variants || []) {
      insVariant.run(
        snapshotId,
        v.sheet,
        v.model,
        v.dimension,
        v.channel,
        v.variant,
        sum(v.daily) || v.so,
        JSON.stringify(v.daily)
      );
    }

    return snapshotId;
  });

  const snapshotId = run();
  audit(uploadedBy, 'snapshot.create', {
    snapshotId,
    period: meta.periodKey,
    cutoffDay: meta.cutoffDay,
    source: meta.sourceName,
    promoters: dataset.promoters.length,
  });
  return snapshotId;
}

/** Elimina un snapshot y todo su detalle. */
export function deleteSnapshot(snapshotId, actor) {
  const row = db.prepare('SELECT stored_file FROM snapshots WHERE id = ?').get(snapshotId);
  if (!row) return false;
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
  if (row.stored_file) {
    try {
      fs.unlinkSync(row.stored_file);
    } catch {
      /* el archivo pudo haberse limpiado antes */
    }
  }
  audit(actor, 'snapshot.delete', { snapshotId });
  return true;
}
