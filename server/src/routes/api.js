/**
 * API REST del dashboard.
 *
 * Convenciones:
 *   - Todas las rutas de datos aceptan los mismos filtros por query string:
 *     snapshot, region, cm, supervisor, channel, store, status, search,
 *     asOfDay, includeOffline.
 *   - Si no se indica `snapshot`, se usa el vigente (corte mas reciente).
 */
import express from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import {
  currentSnapshotId,
  listSnapshots,
  loadSnapshot,
  previousSnapshotId,
} from '../analytics/snapshot.js';
import {
  buildAttendance,
  buildComparison,
  buildFilters,
  buildHierarchy,
  buildModels,
  buildOverview,
  buildPromoterDetail,
  buildPromoters,
  buildStores,
} from '../analytics/views.js';
import { DEFAULT_MIN_DAILY, SECTIONS, buildReport } from '../analytics/report.js';
import { toCsv } from '../utils/csv.js';

export const api = express.Router();

/** Lee los filtros comunes de la query string. */
function readFilters(req) {
  const q = req.query || {};
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return {
    region: clean(q.region),
    cm: clean(q.cm),
    supervisor: clean(q.supervisor),
    channel: clean(q.channel),
    store: clean(q.store),
    status: clean(q.status),
    search: clean(q.search),
    asOfDay: q.asOfDay !== undefined && q.asOfDay !== '' ? Number(q.asOfDay) : undefined,
    includeOffline: /^(1|true|yes)$/i.test(String(q.includeOffline || '')),
  };
}

/**
 * Opciones del reporte de impresion.
 * A diferencia de los filtros del tablero —de un valor— el alcance del reporte
 * es multiple: se pueden elegir varias regiones, CMs, supervisores o promotores
 * a la vez y el documento trae el analisis de cada uno.
 */
function readReportOptions(req) {
  const q = req.query || {};
  const list = (v) =>
    String(v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const sections = list(q.sections).filter((s) => SECTIONS.includes(s.toLowerCase()));
  const minDaily = Number(q.minDaily);
  return {
    regions: list(q.regions),
    cms: list(q.cms),
    supervisors: list(q.supervisors),
    promoters: list(q.promoters),
    sections: sections.length ? sections : SECTIONS,
    withDaily: /^(1|true|yes)$/i.test(String(q.withDaily || '')),
    minDaily: Number.isFinite(minDaily) && minDaily > 0 ? minDaily : DEFAULT_MIN_DAILY,
  };
}

/** Resuelve el snapshot pedido (o el vigente) y lo carga. */
function resolveSnapshot(req, res) {
  const requested = req.query.snapshot ? Number(req.query.snapshot) : null;
  const id = requested || currentSnapshotId(req.query.period || undefined);
  if (!id) {
    res.status(404).json({
      error: 'Todavia no hay informacion cargada. Sube el archivo de Excel para comenzar.',
      code: 'NO_SNAPSHOT',
    });
    return null;
  }
  const snap = loadSnapshot(id);
  if (!snap) {
    res.status(404).json({ error: `No existe el snapshot ${id}.`, code: 'SNAPSHOT_NOT_FOUND' });
    return null;
  }
  return snap;
}

/** Envuelve un handler de vista para no repetir el manejo de errores. */
function view(builder) {
  return (req, res) => {
    const snap = resolveSnapshot(req, res);
    if (!snap) return;
    res.json(builder(snap, readFilters(req), req));
  };
}

api.use(requireAuth);

/* ------------------------------ catalogo ------------------------------ */

api.get('/snapshots', (req, res) => {
  const snapshots = listSnapshots();
  res.json({ snapshots, currentId: currentSnapshotId() });
});

/**
 * Catalogos para poblar los filtros.
 *
 * Mientras no haya ninguna carga, responde con listas vacias en vez de 404: es
 * una situacion normal (sistema recien instalado), no un error, y el tablero
 * debe poder pintarse igual para mostrar la invitacion a subir el archivo.
 */
api.get('/filters', (req, res) => {
  const requested = req.query.snapshot ? Number(req.query.snapshot) : null;
  const id = requested || currentSnapshotId(req.query.period || undefined);
  const snap = id ? loadSnapshot(id) : null;
  if (!snap) {
    return res.json({
      regions: [],
      cms: [],
      supervisors: [],
      channels: [],
      stores: [],
      statuses: [],
      relations: [],
    });
  }
  return res.json(buildFilters(snap));
});

/* -------------------------------- vistas -------------------------------- */

api.get('/overview', view((snap, filters) => buildOverview(snap, filters)));
api.get('/hierarchy', view((snap, filters) => buildHierarchy(snap, filters)));
api.get('/promoters', view((snap, filters) => buildPromoters(snap, filters)));
api.get('/models', view((snap, filters) => buildModels(snap, filters)));
api.get('/stores', view((snap, filters) => buildStores(snap, filters)));
api.get('/attendance', view((snap, filters) => buildAttendance(snap, filters)));

/** Documento completo para impresion, con el alcance y el detalle pedidos. */
api.get('/report', (req, res) => {
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  res.json(buildReport(snap, readFilters(req), readReportOptions(req)));
});

api.get('/promoters/:id', (req, res) => {
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  const detail = buildPromoterDetail(snap, req.params.id, readFilters(req));
  if (!detail) return res.status(404).json({ error: 'Promotor no encontrado en este snapshot.' });
  return res.json(detail);
});

/** Comparativa contra el snapshot anterior del mismo periodo. */
api.get('/comparison', (req, res) => {
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  const prevId = req.query.against ? Number(req.query.against) : previousSnapshotId(snap.meta.id);
  if (!prevId) {
    return res.json({
      available: false,
      message: 'Aun no hay una carga anterior de este periodo con la cual comparar.',
    });
  }
  const prev = loadSnapshot(prevId);
  if (!prev) return res.status(404).json({ error: 'El snapshot de comparacion no existe.' });
  return res.json({ available: true, ...buildComparison(snap, prev, readFilters(req)) });
});

/* ----------------------------- exportaciones ----------------------------- */

const EXPORTS = {
  promotores: (snap, filters) => {
    const { promoters } = buildPromoters(snap, filters);
    return promoters.map((p) => ({
      Region: p.region,
      CM: p.cm,
      Supervisor: p.supervisor,
      Canal: p.channel,
      Tienda: p.store,
      Tiendas: (p.stores || [p.store]).join(' | '),
      Num_tiendas: p.storeCount || 1,
      Promotor: p.name,
      Tipo: p.employment,
      Target: p.target,
      SO_modelos_foco: p.so,
      SO_todas_series: p.soAll,
      IOT: p.soIot,
      'ACH%': p.ach,
      Cierre_proyectado: p.forecast,
      'ACH%_proyectado': p.projectedAch,
      Estatus: p.status,
      Dias_asistidos: p.attendanceDays,
      Dias_en_cero: p.zeroSaleDays,
      Productividad: p.productivity,
      Ranking: p.rank,
    }));
  },
  bajo_rendimiento: (snap, filters, options) => {
    const { lowPerformance, context } = buildReport(snap, filters, {
      ...options,
      sections: ['bajo_rendimiento'],
    });
    return (lowPerformance?.rows || []).map((p) => ({
      Region: p.region,
      CM: p.cm,
      Supervisor: p.supervisor,
      Canal: p.channel,
      Tienda: (p.stores || [p.store]).join(' | '),
      Promotor: p.name,
      Tipo: p.employment,
      Target: p.target,
      SO_modelos_foco: p.so,
      'ACH%': p.ach,
      Dias_asistidos: p.attendanceDays,
      Dias_en_cero: p.zeroSaleDays,
      Pzs_por_dia_asistido: p.productivity,
      Bajo_el_percapita: p.belowRate ? 'SI' : 'NO',
      Cierre_proyectado: p.forecast,
      'ACH%_proyectado': p.projectedAch,
      Bajo_el_minimo_60: p.belowMinimum ? 'SI' : 'NO',
      Piezas_para_el_minimo: p.missingForMinimum,
      Pzs_dia_para_el_minimo: p.dailyForMinimum,
      Dias_restantes: context.daysInMonth - context.cutoffDay,
      Estatus: p.status,
    }));
  },
  supervisores: (snap, filters) => {
    const { regions } = buildHierarchy(snap, filters);
    const out = [];
    for (const r of regions) {
      for (const cm of r.cms) {
        for (const sp of cm.supervisors) {
          out.push({
            Region: r.name,
            CM: cm.name,
            Supervisor: sp.name,
            Promotores: sp.headcount,
            Target: sp.target,
            SO: sp.so,
            'ACH%': sp.ach,
            Cierre_proyectado: sp.forecast,
            'ACH%_proyectado': sp.projectedAch,
            Requerido_diario: sp.requiredDaily,
            Estatus: sp.status,
          });
        }
      }
    }
    return out;
  },
  tiendas: (snap, filters) =>
    buildStores(snap, filters).stores.map((s) => ({
      Region: s.region,
      Canal: s.channel,
      CM: s.cm,
      Supervisor: s.supervisor,
      Tienda: s.name,
      Promotores: s.headcount,
      Target: s.target,
      SO: s.so,
      'ACH%': s.ach,
      Cierre_proyectado: s.forecast,
      Estatus: s.status,
    })),
  diario: (snap, filters) =>
    buildOverview(snap, filters).daily.map((d) => ({
      Dia: d.day,
      Fecha: d.date,
      Dia_semana: d.weekday,
      SO_modelos_foco: d.so,
      SO_todas_series: d.soAll,
      IOT: d.iot,
      Asistencias: d.attendance,
      Promotores_en_cero: d.zeroSale,
      Acumulado: d.cumulative,
      Curva_target: d.targetCurve,
      Proyeccion: d.projection,
    })),
};

api.get('/export/:dataset.csv', (req, res) => {
  const builder = EXPORTS[req.params.dataset];
  if (!builder) return res.status(404).json({ error: 'Exportacion no disponible.' });
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  const rows = builder(snap, readFilters(req), readReportOptions(req));
  const filename = `${req.params.dataset}_${snap.meta.periodKey}_d${snap.meta.cutoffDay}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(toCsv(rows));
});

/* ----------------------------- administracion ----------------------------- */

api.get('/admin/audit', requireRole('admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({
    entries: db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit),
  });
});

export default api;
