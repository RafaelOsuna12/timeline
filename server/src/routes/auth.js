/** Rutas de sesion y administracion de usuarios. */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { audit } from '../db.js';
import {
  ROLES,
  createUser,
  deleteUser,
  issueToken,
  listUsers,
  requireAuth,
  requireRole,
  updateUser,
  verifyCredentials,
} from '../auth.js';

export const authRoutes = express.Router();

// Freno a la fuerza bruta: 10 intentos por IP cada 15 minutos.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Espera unos minutos e intenta de nuevo.' },
});

authRoutes.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contrasena son obligatorios.' });
  }
  const user = verifyCredentials(username, password);
  if (!user) {
    audit(String(username).toLowerCase(), 'auth.login.failed', { ip: req.ip });
    return res.status(401).json({ error: 'Usuario o contrasena incorrectos.' });
  }
  audit(user.username, 'auth.login', { ip: req.ip });
  return res.json({
    token: issueToken(user),
    user: { username: user.username, name: user.display_name, role: user.role },
  });
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, name: req.user.name, role: req.user.role } });
});

/* --------------------------- usuarios (admin) --------------------------- */

authRoutes.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ users: listUsers(), roles: ROLES });
});

authRoutes.post('/users', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const user = createUser(req.body || {});
    audit(req.user.username, 'user.create', { username: user.username, role: user.role });
    res.status(201).json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

authRoutes.patch('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const user = updateUser(Number(req.params.id), req.body || {});
    audit(req.user.username, 'user.update', { id: Number(req.params.id) });
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

authRoutes.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const ok = deleteUser(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Usuario no encontrado.' });
    audit(req.user.username, 'user.delete', { id: Number(req.params.id) });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

export default authRoutes;
