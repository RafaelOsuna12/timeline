/**
 * API de paqueteria.
 *
 * A diferencia del resto del sitio, aqui se escribe: son los unicos datos que
 * se capturan a mano. Las lecturas estan abiertas a cualquier sesion, la
 * escritura pide editor o administrador y la baja solo administrador, igual
 * que la carga de archivos.
 */
import express from 'express';
import { audit } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCsv } from '../utils/csv.js';
import {
  ENTREGAS,
  ESTADOS,
  buildAgenda,
  createPackage,
  getPackage,
  listCarriers,
  listCities,
  listOffices,
  listPackages,
  listRecipients,
  packagesCsv,
  removePackage,
  setStatus,
  summarize,
  todayIso,
  updatePackage,
} from '../packages.js';

export const packages = express.Router();
packages.use(requireAuth);

const actorOf = (req) => req.user?.username || null;

function readFilters(req) {
  const q = req.query || {};
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return {
    scope: clean(q.scope),
    status: clean(q.status),
    carrier: clean(q.carrier),
    region: clean(q.region),
    recipient: clean(q.recipient),
    deliveryMode: clean(q.deliveryMode),
    search: clean(q.search),
  };
}

/** Traduce un error del dominio a una respuesta; deja pasar lo inesperado. */
function fail(res, err) {
  if (err?.status === 409 && err.code === 'DUPLICADO') {
    return res.status(409).json({ error: err.message, code: err.code, duplicate: err.duplicate });
  }
  if (err?.status === 400) return res.status(400).json({ error: err.message, code: err.code });
  throw err;
}

/* ------------------------------- consultas ------------------------------- */

/** Todo lo que el formulario necesita para dibujarse, en una sola peticion. */
packages.get('/catalogs', (req, res) => {
  const { personas, oficinas } = listRecipients();
  res.json({
    today: todayIso(),
    carriers: listCarriers(),
    offices: oficinas,
    recipients: personas,
    cities: listCities(),
    statuses: ESTADOS,
    deliveryModes: ENTREGAS,
  });
});

packages.get('/catalogs/offices', requireRole('admin'), (req, res) => res.json(listOffices({ all: true })));

packages.get('/', (req, res) => res.json(listPackages(readFilters(req))));
packages.get('/agenda', (req, res) => res.json(buildAgenda(readFilters(req))));
packages.get('/summary', (req, res) => res.json(summarize()));

packages.get('/export/paquetes.csv', (req, res) => {
  const rows = packagesCsv(readFilters(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="paqueteria_${todayIso()}.csv"`);
  res.send(toCsv(rows));
});

packages.get('/:id', (req, res) => {
  const pkg = getPackage(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Esa guia no existe.' });
  return res.json(pkg);
});

/* ------------------------------- escritura ------------------------------- */

packages.post('/', requireRole('admin', 'editor'), (req, res) => {
  try {
    const pkg = createPackage(req.body || {}, actorOf(req));
    audit(actorOf(req), 'paquete_alta', { id: pkg.id, guia: pkg.tracking, para: pkg.recipientName });
    return res.status(201).json(pkg);
  } catch (err) {
    return fail(res, err);
  }
});

packages.patch('/:id', requireRole('admin', 'editor'), (req, res) => {
  try {
    const pkg = updatePackage(req.params.id, req.body || {}, actorOf(req));
    if (!pkg) return res.status(404).json({ error: 'Esa guia no existe.' });
    audit(actorOf(req), 'paquete_cambio', { id: pkg.id, guia: pkg.tracking });
    return res.json(pkg);
  } catch (err) {
    return fail(res, err);
  }
});

packages.post('/:id/status', requireRole('admin', 'editor'), (req, res) => {
  try {
    const pkg = setStatus(req.params.id, String(req.body?.status || '').toUpperCase(), actorOf(req), req.body?.note);
    if (!pkg) return res.status(404).json({ error: 'Esa guia no existe.' });
    audit(actorOf(req), 'paquete_estado', { id: pkg.id, guia: pkg.tracking, estado: pkg.status });
    return res.json(pkg);
  } catch (err) {
    return fail(res, err);
  }
});

packages.delete('/:id', requireRole('admin'), (req, res) => {
  const out = removePackage(req.params.id, actorOf(req));
  if (!out) return res.status(404).json({ error: 'Esa guia no existe.' });
  audit(actorOf(req), 'paquete_baja', out);
  return res.json({ ok: true, ...out });
});
