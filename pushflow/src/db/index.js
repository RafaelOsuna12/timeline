import pg from 'pg';
import config from '../config.js';

// Devuelve BIGINT/NUMERIC como número JS cuando cabe (contadores de estadísticas).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const poolConfig = config.db.connectionString
  ? { connectionString: config.db.connectionString, ssl: config.db.ssl, max: config.db.max }
  : {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      ssl: config.db.ssl,
      max: config.db.max,
    };

export const pool = new pg.Pool({
  ...poolConfig,
  idleTimeoutMillis: 30000,
  application_name: 'pushflow',
  statement_timeout: config.db.statementTimeoutMs,
});

pool.on('error', (err) => {
  console.error('[db] error inesperado en cliente inactivo:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Primera fila o null. */
export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

/** Todas las filas. */
export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Valor escalar de la primera columna de la primera fila. */
export async function scalar(text, params) {
  const { rows } = await pool.query(text, params);
  if (!rows[0]) return null;
  return rows[0][Object.keys(rows[0])[0]];
}

/** Ejecuta fn dentro de una transacción. */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* conexión perdida */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Constructor incremental de listas de parámetros ($1, $2, ...).
 * Evita concatenar valores en el SQL.
 */
export class Params {
  constructor(start = 0) {
    this.values = [];
    this.offset = start;
  }
  add(value) {
    this.values.push(value);
    return `$${this.offset + this.values.length}`;
  }
}

export async function healthcheck() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - started };
}

export async function closePool() {
  await pool.end();
}

export default { pool, query, one, many, scalar, transaction, Params, healthcheck, closePool };
