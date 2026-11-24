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
`);

export function audit(actor, action, detail) {
  db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)').run(
    new Date().toISOString(),
    actor || null,
    action,
    typeof detail === 'string' ? detail : JSON.stringify(detail ?? null)
  );
}

export default db;
