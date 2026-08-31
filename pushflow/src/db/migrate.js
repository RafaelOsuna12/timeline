#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import config from '../config.js';
import { pool } from './index.js';

const dir = resolve(config.rootDir, 'migrations');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms int
    )`);
}

function files() {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

async function applied() {
  const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function up() {
  await ensureTable();
  const done = await applied();
  let count = 0;
  for (const name of files()) {
    const sql = readFileSync(resolve(dir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    if (done.has(name)) {
      if (done.get(name) !== checksum) {
        console.warn(`  ! ${name} cambió después de aplicarse (checksum distinto)`);
      }
      continue;
    }
    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1,$2,$3)',
        [name, checksum, Date.now() - started]);
      await client.query('COMMIT');
      console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${name}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(count ? `${count} migración(es) aplicadas.` : 'La base de datos ya está al día.');
}

async function status() {
  await ensureTable();
  const done = await applied();
  for (const name of files()) {
    console.log(`  ${done.has(name) ? '✓ aplicada ' : '· pendiente'}  ${name}`);
  }
}

const cmd = process.argv[2] || 'up';
try {
  if (cmd === 'up') await up();
  else if (cmd === 'status') await status();
  else { console.error('Uso: migrate.js [up|status]'); process.exitCode = 1; }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
