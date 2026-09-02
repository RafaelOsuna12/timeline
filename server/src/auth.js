/**
 * Autenticacion por JWT y gestion de usuarios.
 *
 * Roles:
 *   - admin  : carga archivos, administra usuarios, borra snapshots
 *   - editor : carga archivos
 *   - viewer : solo consulta
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, audit } from './db.js';
import { config } from './config.js';

export const ROLES = ['admin', 'editor', 'viewer'];
const UPLOAD_ROLES = new Set(['admin', 'editor']);

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

export function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
}

export function listUsers() {
  return db
    .prepare('SELECT id, username, display_name, role, created_at, last_login FROM users ORDER BY username')
    .all();
}

export function createUser({ username, password, displayName, role = 'viewer' }) {
  const clean = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(clean)) {
    throw new Error('El usuario debe tener entre 3 y 40 caracteres (letras, numeros, punto, guion o guion bajo).');
  }
  if (!password || String(password).length < 10) {
    throw new Error('La contrasena debe tener al menos 10 caracteres.');
  }
  if (!ROLES.includes(role)) throw new Error(`Rol invalido: ${role}`);
  if (findUser(clean)) throw new Error('Ese usuario ya existe.');

  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)'
    )
    .run(clean, hashPassword(password), displayName || clean, role, new Date().toISOString());
  return { id: info.lastInsertRowid, username: clean, displayName: displayName || clean, role };
}

export function updateUser(id, { password, displayName, role }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('Usuario no encontrado.');
  if (role && !ROLES.includes(role)) throw new Error(`Rol invalido: ${role}`);
  if (password && String(password).length < 10) throw new Error('La contrasena debe tener al menos 10 caracteres.');

  db.prepare(
    `UPDATE users SET
       password_hash = COALESCE(?, password_hash),
       display_name  = COALESCE(?, display_name),
       role          = COALESCE(?, role)
     WHERE id = ?`
  ).run(password ? hashPassword(password) : null, displayName ?? null, role ?? null, id);
  return db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(id);
}

export function deleteUser(id) {
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return false;
  if (user.role === 'admin' && admins <= 1) {
    throw new Error('No se puede eliminar el unico administrador del sistema.');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

export function verifyCredentials(username, password) {
  const user = findUser(username);
  if (!user) return null;
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  return user;
}

export function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, name: user.display_name, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

/** Middleware: exige un token valido. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sesion requerida.' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Sesion expirada o invalida. Vuelve a iniciar sesion.' });
  }
}

/** Middleware: exige uno de los roles indicados. */
export function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sesion requerida.' });
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para esta operacion.' });
    }
    return next();
  };
}

export const requireUpload = requireRole(...UPLOAD_ROLES);

/**
 * Crea el administrador inicial si la base esta vacia.
 * La contrasena solo se toma de ADMIN_PASSWORD; si no esta definida, el
 * sistema arranca sin usuarios y lo indica en el log (nunca genera una
 * contrasena por defecto adivinable).
 */
export function bootstrapAdmin() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (total > 0) return null;
  const { username, password, displayName } = config.bootstrap;
  if (!password) {
    console.warn(
      '[auth] No hay usuarios y ADMIN_PASSWORD no esta definida.\n' +
        '       Crea el primer administrador con: node src/scripts/create-user.js <usuario> <contrasena> admin'
    );
    return null;
  }
  const user = createUser({ username, password, displayName, role: 'admin' });
  audit('system', 'user.bootstrap', { username: user.username });
  console.log(`[auth] Administrador inicial creado: ${user.username}`);
  return user;
}
