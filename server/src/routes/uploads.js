/**
 * Carga y procesamiento del archivo de Excel.
 *
 * El parseo del libro tarda ~20 segundos, mas de lo que conviene mantener una
 * peticion HTTP abierta detras de un proxy. Por eso la carga responde de
 * inmediato con un `jobId` y el frontend consulta el avance en
 * `GET /api/uploads/jobs/:id` hasta que termina.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { audit, db } from '../db.js';
import { requireAuth, requireRole, requireUpload } from '../auth.js';
import { parseWorkbookFile } from '../parser/index.js';
import { fileHash, saveSnapshot, deleteSnapshot } from '../ingest.js';
import { invalidateCache, listSnapshots } from '../analytics/snapshot.js';

export const uploads = express.Router();

const ACCEPTED_EXT = new Set(['.xlsx', '.xlsm']);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    cb(null, config.uploadDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `incoming_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ACCEPTED_EXT.has(ext)) {
      cb(new Error('Solo se aceptan archivos .xlsx o .xlsm del reporte diario.'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Trabajos en memoria. Son efimeros a proposito: el resultado real queda en la
 * base como snapshot, el job solo comunica el avance de un procesamiento.
 */
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function createJob(meta) {
  const id = crypto.randomUUID();
  const job = {
    id,
    state: 'queued',
    progress: 0,
    step: 'En cola',
    createdAt: new Date().toISOString(),
    ...meta,
  };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref?.();
  return job;
}

function setJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

uploads.use(requireAuth);

/**
 * POST /api/uploads
 * Recibe el archivo, lo deja en disco y lanza el procesamiento en segundo plano.
 */
uploads.post('/', requireUpload, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `El archivo supera el limite de ${config.maxUploadMb} MB.`
          : err.message || 'No se pudo recibir el archivo.';
      // Sin esta traza, un rechazo de la carga no deja rastro en el servidor y
      // solo se ve como un error generico en el navegador.
      console.warn(
        `[upload] rechazado (${req.user?.username || 'sin usuario'}): ${message}` +
          ` | archivo="${err.field || ''}" code=${err.code || 'n/d'}`
      );
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      console.warn(`[upload] peticion sin archivo de ${req.user?.username || 'sin usuario'}`);
      return res.status(400).json({ error: 'No se recibio ningun archivo.' });
    }
    console.log(
      `[upload] recibido "${req.file.originalname}" (${(req.file.size / 1048576).toFixed(1)} MB) de ${req.user.username}`
    );

    const job = createJob({
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      uploadedBy: req.user.username,
    });

    // Se responde de inmediato; el parseo continua en segundo plano.
    res.status(202).json({ jobId: job.id, state: job.state });
    processUpload(job, req.file, req.user).catch((error) => {
      console.error('[upload] fallo el procesamiento', error);
      setJob(job.id, { state: 'error', error: error.message, step: 'Error' });
    });
    return undefined;
  });
});

async function processUpload(job, file, user) {
  const tempPath = file.path;
  try {
    setJob(job.id, { state: 'running', progress: 10, step: 'Leyendo el libro de Excel' });
    const hash = fileHash(tempPath);

    const duplicate = db.prepare('SELECT id, created_at FROM snapshots WHERE file_hash = ?').get(hash);
    if (duplicate && !job.force) {
      // No es un error: se informa y se reutiliza el snapshot ya procesado.
      fs.unlinkSync(tempPath);
      setJob(job.id, {
        state: 'done',
        progress: 100,
        step: 'Archivo identico a una carga previa',
        duplicate: true,
        snapshotId: duplicate.id,
        message: `Este archivo ya se habia cargado el ${new Date(duplicate.created_at).toLocaleString('es-MX')}. Se mantiene la informacion existente.`,
      });
      return;
    }

    setJob(job.id, { progress: 25, step: 'Analizando hojas y detectando el periodo' });
    const dataset = await parseWorkbookFile(tempPath, { sourceName: file.originalname });

    setJob(job.id, {
      progress: 70,
      step: `Guardando ${dataset.promoters.length} promotores del periodo ${dataset.meta.periodKey}`,
    });

    let stored = null;
    if (config.keepSourceFiles) {
      stored = path.join(config.uploadDir, `${dataset.meta.periodKey}_d${dataset.meta.cutoffDay}_${hash.slice(0, 10)}${path.extname(file.originalname).toLowerCase()}`);
      fs.renameSync(tempPath, stored);
    } else {
      fs.unlinkSync(tempPath);
    }

    const snapshotId = saveSnapshot(dataset, { storedFile: stored, hash, uploadedBy: user.username });
    invalidateCache();

    setJob(job.id, {
      state: 'done',
      progress: 100,
      step: 'Listo',
      snapshotId,
      summary: {
        periodKey: dataset.meta.periodKey,
        cutoffDay: dataset.meta.cutoffDay,
        daysInMonth: dataset.meta.daysInMonth,
        promoters: dataset.promoters.length,
        leaders: dataset.supervisors.length,
        warnings: dataset.meta.warnings,
      },
    });
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* nada que limpiar */
    }
    throw error;
  }
}

/** GET /api/uploads/jobs/:id — avance del procesamiento. */
uploads.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'El trabajo ya no esta disponible.' });
  return res.json(job);
});

/** GET /api/uploads — historial de cargas. */
uploads.get('/', (req, res) => {
  res.json({ snapshots: listSnapshots() });
});

/** DELETE /api/uploads/:snapshotId — elimina una carga (solo admin). */
uploads.delete('/:snapshotId', requireRole('admin'), (req, res) => {
  const id = Number(req.params.snapshotId);
  const total = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n;
  if (total <= 1) {
    return res.status(400).json({ error: 'No se puede eliminar la unica carga disponible.' });
  }
  const ok = deleteSnapshot(id, req.user.username);
  if (!ok) return res.status(404).json({ error: 'Snapshot no encontrado.' });
  invalidateCache();
  return res.json({ ok: true });
});

/** GET /api/uploads/:snapshotId/file — descarga el Excel original. */
uploads.get('/:snapshotId/file', (req, res) => {
  const row = db
    .prepare('SELECT stored_file, source_name FROM snapshots WHERE id = ?')
    .get(Number(req.params.snapshotId));
  if (!row || !row.stored_file || !fs.existsSync(row.stored_file)) {
    return res.status(404).json({ error: 'El archivo original ya no esta disponible.' });
  }
  audit(req.user.username, 'snapshot.download', { snapshotId: Number(req.params.snapshotId) });
  return res.download(row.stored_file, row.source_name || path.basename(row.stored_file));
});

export default uploads;
