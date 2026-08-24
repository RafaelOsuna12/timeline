#!/usr/bin/env node
/**
 * Crea la organización y el primer usuario del panel.
 *   node scripts/create-admin.js --email admin@midominio.com --password "..." --org "Mi empresa"
 * Si no se pasa contraseña, se genera una aleatoria y se muestra.
 */
import { randomBytes } from 'node:crypto';
import { pool, one } from '../src/db/index.js';
import { hashPassword } from '../src/lib/crypto.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
}

const email = arg('email');
const orgName = arg('org', 'Mi organización');
let password = arg('password');

if (!email) {
  console.error('Uso: node scripts/create-admin.js --email tu@email.com [--password "..."] [--org "Nombre"]');
  process.exit(1);
}
if (!password) {
  password = randomBytes(12).toString('base64url');
  console.log(`\n  Contraseña generada: ${password}\n  (guárdala, no se volverá a mostrar)\n`);
} else if (password.length < 10) {
  console.error('La contraseña debe tener al menos 10 caracteres.');
  process.exit(1);
}

try {
  const existing = await one('SELECT id FROM admin_users WHERE lower(email) = lower($1)', [email]);
  if (existing) {
    console.error(`Ya existe un usuario con el email ${email}.`);
    process.exit(1);
  }
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
  const org = await one(
    `INSERT INTO organizations (name, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [orgName, slug]);
  const user = await one(
    `INSERT INTO admin_users (org_id, email, name, password_hash, role)
     VALUES ($1,$2,$3,$4,'owner') RETURNING id, email`,
    [org.id, email, arg('name', email.split('@')[0]), hashPassword(password)]);
  console.log(`Usuario creado: ${user.email} (organización: ${orgName})`);
  console.log('Ya puedes entrar en el panel con esas credenciales.');
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
