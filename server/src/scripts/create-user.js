#!/usr/bin/env node
/**
 * Alta de usuarios desde la terminal:
 *   node src/scripts/create-user.js <usuario> <contrasena> [rol] [nombre]
 * Roles: admin | editor | viewer   (por defecto: viewer)
 */
import { createUser } from '../auth.js';

const [username, password, role = 'viewer', ...nameParts] = process.argv.slice(2);
if (!username || !password) {
  console.error('Uso: node src/scripts/create-user.js <usuario> <contrasena> [rol] [nombre]');
  process.exit(1);
}
try {
  const user = createUser({ username, password, role, displayName: nameParts.join(' ') || username });
  console.log(`Usuario creado: ${user.username} (${user.role})`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
