/**
 * API de plantilla (Datos del personal).
 *
 * La carga del archivo es sincrona, a diferencia de la del reporte de ventas:
 * leer el libro de plantilla toma menos de un segundo, asi que no hace falta
 * el mecanismo de trabajo en segundo plano y la respuesta puede traer ya el
 * resumen de cambios detectados.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { audit, db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { parseHeadcountFile } from '../parser/headcount.js';
import { fileHash, saveHeadcount } from '../ingest-headcount.js';
import {
  buildChanges,
  buildDirectory,
  buildHeadcountFilters,
  buildPersonDetail,
  buildStoreRoster,
  currentHeadcountId,
  invalidateHeadcountCache,
  listHeadcountSnapshots,
  loadHeadcount,
} from '../analytics/headcount.js';
import { toCsv } from '../utils/csv.js';

export const headcount = express.Router();
headcount.use(requireAuth);

/* ------------------------------- consultas ------------------------------- */

function readFilters(req) {
  const q = req.query || {};
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return {
    region: clean(q.region),
    role: clean(q.role),
    channel: clean(q.channel),
    state: clean(q.state),
    city: clean(q.city),
    status: clean(q.status),
    source: clean(q.source),
    search: clean(q.search),
    onlyActive: /^(1|true|yes)$/i.test(String(q.onlyActive || '')),
  };
}

/** Resuelve la carga pedida (o la vigente) y la trae a memoria. */
function resolveSnapshot(req, res) {
  const requested = req.query.hc ? Number(req.query.hc) : null;
  const id = requested || currentHeadcountId();
  if (!id) {
    res.status(404).json({
      error: 'Todavia no hay plantilla cargada. Sube el archivo HC para comenzar.',
      code: 'NO_HEADCOUNT',
    });
    return null;
  }
  const snap = loadHeadcount(id);
  if (!snap) {
    res.status(404).json({ error: 'La carga solicitada no existe.' });
    return null;
  }
  return snap;
}

const view = (builder) => (req, res) => {
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  res.json(builder(snap, readFilters(req), req));
};

headcount.get('/snapshots', (req, res) => {
  res.json({ snapshots: listHeadcountSnapshots(), currentId: currentHeadcountId() });
});

headcount.get('/filters', view((snap) => buildHeadcountFilters(snap)));
headcount.get('/directory', view((snap, filters) => buildDirectory(snap, filters)));
headcount.get('/stores', view((snap, filters) => buildStoreRoster(snap, filters)));
headcount.get('/changes', view((snap, filters) => buildChanges(snap, filters)));

headcount.get('/people/:key', (req, res) => {
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  const detail = buildPersonDetail(snap, req.params.key);
  if (!detail) return res.status(404).json({ error: 'Persona no encontrada en esta carga.' });
  return res.json(detail);
});

/* ------------------------------ exportacion ------------------------------ */

const EXPORTS = {
  personal: (snap, filters) =>
    buildDirectory(snap, filters).people.map((p) => ({
      Nombre: p.name,
      Rol: p.roleLabel,
      ID_HONOR: p.personId,
      ID_agencia: p.agencyId,
      Region: p.region,
      Estado: p.state,
      Ciudad: p.city,
      Tipo_de_plaza: p.employment,
      Estatus: p.status,
      Fecha_de_ingreso: p.hireDate,
      Antiguedad_meses: p.tenureMonths,
      Tiendas: p.storeCount,
      Lista_de_tiendas: p.stores.join(' | '),
      Canales: p.channels.join(' | '),
      Origen: p.source,
    })),
  tiendas: (snap, filters) =>
    buildStoreRoster(snap, filters).stores.map((s) => ({
      Tienda: s.store,
      ID: s.storeId,
      Canal: s.channel,
      Region: s.region,
      Estado: s.state,
      Ciudad: s.city,
      Listado: s.listing,
      Activa: s.active ? 'SI' : 'NO',
      Cubiertas: s.staffed,
      Vacantes: s.vacancies,
      Plantilla: s.staff.map((a) => `${a.roleLabel}: ${a.vacancy ? 'VACANTE' : a.name}`).join(' | '),
      Direccion: s.address,
    })),
  vacantes: (snap, filters) =>
    buildDirectory(snap, filters).vacancies.map((v) => ({
      Tienda: v.store,
      ID: v.storeId,
      Canal: v.channel,
      Region: v.region,
      Ciudad: v.city,
      Rol: v.roleLabel,
    })),
  cambios: (snap, filters) =>
    buildChanges(snap, filters).changes.map((c) => ({
      Movimiento: c.kind,
      Persona: c.name,
      Rol: c.roleLabel,
      Region: c.region,
      Detalle: JSON.stringify(c.detail),
    })),
};

headcount.get('/export/:dataset.csv', (req, res) => {
  const builder = EXPORTS[req.params.dataset];
  if (!builder) return res.status(404).json({ error: 'Exportacion no disponible.' });
  const snap = resolveSnapshot(req, res);
  if (!snap) return;
  const rows = builder(snap, readFilters(req));
  const fecha = (snap.meta.createdAt || '').slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="personal_${req.params.dataset}_${fecha}.csv"`);
  return res.send(toCsv(rows));
});

/* -------------------------------- carga -------------------------------- */

// El archivo nativo es .xlsb; se aceptan tambien los formatos de Excel por si
// algun dia lo exportan distinto.
const ACCEPTED_EXT = new Set(['.xlsb', '.xlsx', '.xlsm']);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    cb(null, config.uploadDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `hc_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ACCEPTED_EXT.has(ext)) {
      cb(new Error('Solo se aceptan archivos .xlsb, .xlsx o .xlsm de la plantilla.'));
      return;
    }
    cb(null, true);
  },
});

headcount.post('/uploads', requireRole('admin', 'editor'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibio ningun archivo.' });

    const tmp = req.file.path;
    const mb = (req.file.size / 1048576).toFixed(1);
    console.log(`[plantilla] recibido "${req.file.originalname}" (${mb} MB) de ${req.user?.username || 'anonimo'}`);

    try {
      const hash = fileHash(tmp);
      const dataset = parseHeadcountFile(tmp, { sourceName: req.file.originalname });
      const stored = path.join(config.uploadDir, `hc_${Date.now()}${path.extname(req.file.originalname).toLowerCase()}`);
      fs.renameSync(tmp, stored);

      const result = saveHeadcount(dataset, {
        storedFile: path.basename(stored),
        hash,
        uploadedBy: req.user?.username || null,
      });
      invalidateHeadcountCache();

      return res.json({
        ok: true,
        id: result.id,
        people: result.people,
        stores: result.stores,
        changes: result.changes,
        previousId: result.previousId,
        warnings: dataset.meta.warnings,
      });
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* el archivo temporal pudo no existir */
      }
      console.error('[plantilla] error al procesar:', e);
      audit(req.user?.username, 'hc_upload_error', { file: req.file.originalname, error: e.message });
      return res.status(422).json({ error: e.message });
    }
  });
});

headcount.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, stored_file FROM hc_snapshots WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'La carga no existe.' });
  db.prepare('DELETE FROM hc_snapshots WHERE id = ?').run(id);
  if (row.stored_file) {
    try {
      fs.unlinkSync(path.join(config.uploadDir, row.stored_file));
    } catch {
      /* ya no estaba */
    }
  }
  invalidateHeadcountCache();
  audit(req.user?.username, 'hc_delete', { id });
  return res.json({ ok: true });
});

export default headcount;
