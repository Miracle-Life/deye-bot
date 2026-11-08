import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE readings (ts INTEGER PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start INTEGER NOT NULL,
    end INTEGER,
    start_approx INTEGER NOT NULL DEFAULT 0,
    start_soc REAL,
    end_soc REAL,
    missing_phases TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX outages_start ON outages(start);
  CREATE INDEX outages_end ON outages(end);
  CREATE TABLE gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, start INTEGER NOT NULL, end INTEGER NOT NULL);
  CREATE INDEX gaps_start ON gaps(start);
  CREATE TABLE users (
    tg_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT,
    status TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `ALTER TABLE users ADD COLUMN night_quiet INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE energy_days (date TEXT PRIMARY KEY, json TEXT NOT NULL, complete INTEGER NOT NULL);`,
  `ALTER TABLE users ADD COLUMN watchdog INTEGER NOT NULL DEFAULT 0;`,
  // Users who existed before languages keep Russian.
  `ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'ru';`,
  // Minutes before a scheduled off/on to remind; 0 = off.
  `ALTER TABLE users ADD COLUMN remind_off_min INTEGER NOT NULL DEFAULT 30;`,
  `ALTER TABLE users ADD COLUMN remind_on_min INTEGER NOT NULL DEFAULT 30;`,
  // Battery health: small, kept forever (raw readings are only kept 90 days).
  `CREATE TABLE battery_days (date TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE capacity_runs (start_ts INTEGER PRIMARY KEY, json TEXT NOT NULL);`,
  // Past YASNO schedules, one row per day (kept like readings, 90 days).
  `CREATE TABLE schedule_days (date TEXT PRIMARY KEY, json TEXT NOT NULL);`,
];

export function openDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // NORMAL is safe with WAL and saves an fsync per write (lets the NAS disks sleep).
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
