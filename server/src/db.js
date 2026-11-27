/**
 * Capa de persistencia (SQLite / better-sqlite3).
 *
 * Cada carga de archivo genera un "snapshot": una foto completa del libro en
 * un momento dado. Conservar todos los snapshots permite comparar el avance
 * entre dos actualizaciones (por ejemplo, hoy contra ayer) y mantener el
 * historico de meses cerrados.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  created_at    TEXT NOT NULL,
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  period_key     TEXT NOT NULL,
  period_year    INTEGER NOT NULL,
  period_month   INTEGER NOT NULL,
  days_in_month  INTEGER NOT NULL,
  cutoff_day     INTEGER NOT NULL,
  cutoff_date    TEXT NOT NULL,
  source_name    TEXT,
  stored_file    TEXT,
  file_hash      TEXT,
  uploaded_by    TEXT,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ready',
  meta_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_period ON snapshots(period_key, cutoff_day, created_at);

CREATE TABLE IF NOT EXISTS promoters (
  snapshot_id      INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  promoter_id      TEXT NOT NULL,
  advisor          TEXT NOT NULL,
  channel          TEXT NOT NULL,
  region           TEXT NOT NULL,
  store            TEXT NOT NULL,
  supervisor       TEXT,
  cm               TEXT,
  status           TEXT,
  target_initial   REAL,
  target_adjusted  REAL,
  target_hq        REAL,
  so_target        REAL,
  so_all           REAL,
  so_iot           REAL,
  attendance_days  REAL,
  zero_sale_days   REAL,
  models_json      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_id, promoter_id)
);
CREATE INDEX IF NOT EXISTS idx_promoters_snapshot ON promoters(snapshot_id, region, cm, supervisor);

CREATE TABLE IF NOT EXISTS promoter_daily (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  promoter_id  TEXT NOT NULL,
  day          INTEGER NOT NULL,
  so_target    REAL NOT NULL DEFAULT 0,
  so_all       REAL NOT NULL DEFAULT 0,
  so_iot       REAL NOT NULL DEFAULT 0,
  attendance   REAL NOT NULL DEFAULT 0,
  zero_sale    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, promoter_id, day)
);

CREATE TABLE IF NOT EXISTS promoter_model_daily (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  promoter_id  TEXT NOT NULL,
  model        TEXT NOT NULL,
  day          INTEGER NOT NULL,
  qty          REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, promoter_id, model, day)
);

CREATE TABLE IF NOT EXISTS leaders (
  snapshot_id    INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  leader_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  position       TEXT NOT NULL,
  region         TEXT NOT NULL,
  cm             TEXT,
  ffs_in_charge  REAL,
  target_hq      REAL,
  so             REAL,
  so_all         REAL,
  models_json    TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_id, leader_id)
);

CREATE TABLE IF NOT EXISTS leader_daily (
  snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  leader_id     TEXT NOT NULL,
  day           INTEGER NOT NULL,
  so            REAL NOT NULL DEFAULT 0,
  attendance    REAL NOT NULL DEFAULT 0,
  zero_sale_ff  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, leader_id, day)
);

CREATE TABLE IF NOT EXISTS model_channel (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  model        TEXT NOT NULL,
  stores       REAL,
  so           REAL,
  productivity REAL,
  daily_json   TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (snapshot_id, channel, model)
);

CREATE TABLE IF NOT EXISTS model_variants (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  sheet        TEXT NOT NULL,
  model        TEXT NOT NULL,
  dimension    TEXT NOT NULL,
  channel      TEXT NOT NULL,
  variant      TEXT NOT NULL,
  so           REAL,
  daily_json   TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (snapshot_id, sheet, dimension, channel, variant)
);

/* ------------------------------------------------------------------ */
/*  Plantilla (HC): personas, tiendas y cambios entre cargas           */
/*                                                                     */
/*  Vive aparte del snapshot de ventas porque se actualiza con otro    */
/*  archivo y a otro ritmo (dos veces por semana contra diario), y     */
/*  cubre mas cadenas. Se cruzaran por person_id cuando haga falta.  */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS hc_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name  TEXT,
  stored_file  TEXT,
  file_hash    TEXT,
  uploaded_by  TEXT,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready',
  meta_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_hc_snapshots_at ON hc_snapshots(created_at DESC);

CREATE TABLE IF NOT EXISTS hc_stores (
  snapshot_id      INTEGER NOT NULL REFERENCES hc_snapshots(id) ON DELETE CASCADE,
  store_id         TEXT NOT NULL,
  store            TEXT NOT NULL,
  store_key        TEXT,
  channel          TEXT,
  region           TEXT,
  state            TEXT,
  city             TEXT,
  city_coverage    TEXT,
  locality         TEXT,
  city_class       TEXT,
  listing          TEXT,
  tier             TEXT,
  address          TEXT,
  channel_store_id TEXT,
  coverage_time    TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  floor            TEXT,
  PRIMARY KEY (snapshot_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_hc_stores_region ON hc_stores(snapshot_id, region, channel);

CREATE TABLE IF NOT EXISTS hc_people (
  snapshot_id  INTEGER NOT NULL REFERENCES hc_snapshots(id) ON DELETE CASCADE,
  person_key   TEXT NOT NULL,
  person_id    TEXT,
  agency_id    TEXT,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  role         TEXT NOT NULL,
  roles_json   TEXT NOT NULL DEFAULT '[]',
  source       TEXT NOT NULL,
  position     TEXT,
  region       TEXT,
  state        TEXT,
  city         TEXT,
  channel      TEXT,
  employment   TEXT,
  status       TEXT,
  hire_date    TEXT,
  store_count  INTEGER NOT NULL DEFAULT 0,
  support_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, person_key)
);
CREATE INDEX IF NOT EXISTS idx_hc_people_region ON hc_people(snapshot_id, region, role);

CREATE TABLE IF NOT EXISTS hc_assignments (
  snapshot_id  INTEGER NOT NULL REFERENCES hc_snapshots(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  store_id     TEXT,
  person_key   TEXT,
  role         TEXT NOT NULL,
  employment   TEXT,
  status       TEXT,
  zone         TEXT,
  route        TEXT,
  PRIMARY KEY (snapshot_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_hc_assign_person ON hc_assignments(snapshot_id, person_key);
CREATE INDEX IF NOT EXISTS idx_hc_assign_store ON hc_assignments(snapshot_id, store_id);

CREATE TABLE IF NOT EXISTS hc_changes (
  snapshot_id  INTEGER NOT NULL REFERENCES hc_snapshots(id) ON DELETE CASCADE,
  previous_id  INTEGER,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  person_key   TEXT,
  name         TEXT,
  role         TEXT,
  region       TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_hc_changes_kind ON hc_changes(snapshot_id, kind);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

/* ------------------------------------------------------------------ */
/*  Paqueteria                                                          */
/*                                                                      */
/*  A diferencia del resto del sistema, esto NO se deriva de un Excel:  */
/*  se captura a mano y cambia de estado con el tiempo. Por eso vive    */
/*  fuera de la familia de snapshots, sin snapshot_id y sin periodo.    */
/*  Es tambien el unico dato del sitio que no se puede regenerar desde  */
/*  un archivo, de ahi la bitacora y el borrado logico.                 */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS pkg_carriers (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  track_url TEXT,
  sort      INTEGER NOT NULL DEFAULT 100,
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pkg_offices (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  city    TEXT,
  state   TEXT,
  address TEXT,
  sort    INTEGER NOT NULL DEFAULT 100,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pkg_packages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking         TEXT NOT NULL,
  tracking_key     TEXT NOT NULL,
  carrier_code     TEXT NOT NULL,
  carrier_other    TEXT,
  delivery_mode    TEXT NOT NULL,
  recipient_kind   TEXT NOT NULL,
  recipient_key    TEXT,
  recipient_name   TEXT NOT NULL,
  recipient_role   TEXT,
  recipient_region TEXT,
  origin_city      TEXT,
  origin_state     TEXT,
  dest_city        TEXT,
  dest_state       TEXT,
  dest_place       TEXT,
  shipped_date     TEXT,
  eta_date         TEXT,
  status           TEXT NOT NULL DEFAULT 'EN_TRANSITO',
  contents         TEXT,
  notes            TEXT,
  delivered_at     TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pkg_eta ON pkg_packages(status, eta_date);
CREATE INDEX IF NOT EXISTS idx_pkg_recipient ON pkg_packages(recipient_key);
CREATE INDEX IF NOT EXISTS idx_pkg_tracking ON pkg_packages(tracking_key);

/* La bitacora es la fuente de las notificaciones: responde "que cambio
   desde tal momento" sin tener que comparar dos estados completos. */
CREATE TABLE IF NOT EXISTS pkg_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES pkg_packages(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  actor      TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pkg_events_pkg ON pkg_events(package_id, at);
CREATE INDEX IF NOT EXISTS idx_pkg_events_at ON pkg_events(at DESC);
`);

/* ------------------------------------------------------------------ */
/*  Migraciones                                                         */
/*                                                                      */
/*  `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya existe, asi   */
/*  que una columna nueva no llega a las instalaciones ya desplegadas.  */
/*  Aqui se agregan una por una, sin tocar los datos: la operacion es   */
/*  idempotente y barata, asi que corre en cada arranque.               */
/* ------------------------------------------------------------------ */

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.length) return; // la tabla todavia no existe: la crea el esquema
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migracion: ${table}.${column} agregada`);
}

// Tiendas activas: las que tienen plaza de promotor. Las cargas anteriores a
// esta columna se quedan con el valor por omision hasta que se vuelva a subir
// el archivo, que es cuando se puede saber cuales lo son.
addColumnIfMissing('hc_stores', 'active', 'INTEGER NOT NULL DEFAULT 1');

// Tipo de plaza de la tienda: BASE cuenta como tienda a trabajar, SUPPORT es
// una tienda de apoyo donde el promotor tambien puede vender.
addColumnIfMissing('hc_stores', 'floor', 'TEXT');
addColumnIfMissing('hc_people', 'support_count', 'INTEGER NOT NULL DEFAULT 0');

/* ------------------------------------------------------------------ */
/*  Catalogos iniciales de paqueteria                                   */
/*                                                                      */
/*  Se siembran una sola vez; despues se administran desde el sitio y   */
/*  un reinicio no pisa lo que el usuario haya cambiado.                */
/*                                                                      */
/*  `track_url` es la pagina publica de rastreo de cada empresa. Se     */
/*  guarda sin el numero de guia a proposito: las ligas con el numero   */
/*  dentro cambian sin aviso y una liga rota es peor que ninguna, asi   */
/*  que el sitio abre la pagina y deja la guia en el portapapeles.      */
/* ------------------------------------------------------------------ */

const PAQUETERIAS = [
  ['DHL', 'DHL', 'https://www.dhl.com/mx-es/home/rastreo.html', 10],
  ['ESTAFETA', 'Estafeta', 'https://www.estafeta.com/herramientas/rastreo', 20],
  ['FEDEX', 'FedEx', 'https://www.fedex.com/es-mx/tracking.html', 30],
  ['UPS', 'UPS', 'https://www.ups.com/track?loc=es_MX', 40],
  ['PAQUETEXPRESS', 'Paquetexpress', 'https://www.paquetexpress.com.mx/', 50],
  ['REDPACK', 'Redpack', 'https://www.redpack.com.mx/', 60],
  ['CASTORES', 'Castores', 'https://www.castores.com.mx/', 70],
  ['TRESGUERRAS', 'Tres Guerras', 'https://www.tresguerras.com.mx/', 80],
  ['CORREOSMX', 'Correos de Mexico', 'https://www.correosdemexico.gob.mx/', 90],
  ['NOVENTAYNUEVE', '99minutos', 'https://99minutos.com/', 100],
  ['JTEXPRESS', 'J&T Express', 'https://www.jtexpress.mx/', 110],
  ['AMPM', 'AMPM', 'https://www.ampm.mx/', 120],
  ['OTRA', 'Otra (se escribe el nombre)', null, 999],
];

const sembrarCatalogo = db.transaction(() => {
  const hay = db.prepare('SELECT COUNT(*) AS n FROM pkg_carriers').get().n;
  if (!hay) {
    const ins = db.prepare('INSERT INTO pkg_carriers (code, name, track_url, sort) VALUES (?,?,?,?)');
    for (const fila of PAQUETERIAS) ins.run(...fila);
    console.log(`[db] catalogo de paqueterias sembrado (${PAQUETERIAS.length})`);
  }
  const oficinas = db.prepare('SELECT COUNT(*) AS n FROM pkg_offices').get().n;
  if (!oficinas) {
    db.prepare('INSERT INTO pkg_offices (code, name, city, state, sort) VALUES (?,?,?,?,?)')
      .run('TIJUANA', 'Oficina HONOR Tijuana', 'TIJUANA', 'BAJA CALIFORNIA', 10);
    console.log('[db] oficina HONOR Tijuana sembrada');
  }
});
sembrarCatalogo();

export function audit(actor, action, detail) {
  db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)').run(
    new Date().toISOString(),
    actor || null,
    action,
    typeof detail === 'string' ? detail : JSON.stringify(detail ?? null)
  );
}

export default db;
