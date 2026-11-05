import type { Interval, Reading } from '../deye/types.js';
import type { DetectorState } from '../domain/detector.js';
import type { EnergyDayRaw } from '../domain/energy.js';
import type { Database } from './db.js';
import type { BatteryDay, CapacityRun } from '../domain/battery.js';
import { isLang, type Lang } from '../i18n/index.js';

export interface OutageRow extends Interval {
  id: number;
  startApprox: boolean;
  startSoc: number | null;
  endSoc: number | null;
  missingPhases: string;
}

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'blocked';

export interface UserRow {
  tgId: number;
  name: string;
  username: string | null;
  status: UserStatus;
  muted: boolean;
  nightQuiet: boolean; // no sound during quiet hours
  watchdog: boolean; // wants "home offline" alerts from the Cloudflare watchdog
  lang: Lang;
  remindOffMin: number; // before a scheduled outage; 0 = off
  remindOnMin: number; // before scheduled power-on; 0 = off
  createdAt: number;
}

type Row = Record<string, any>;

const toUser = (r: Row): UserRow => ({
  tgId: Number(r.tg_id),
  name: r.name,
  username: r.username ?? null,
  status: r.status,
  muted: !!r.muted,
  nightQuiet: !!r.night_quiet,
  watchdog: !!r.watchdog,
  lang: isLang(r.lang) ? r.lang : 'ru',
  remindOffMin: Number(r.remind_off_min ?? 30),
  remindOnMin: Number(r.remind_on_min ?? 30),
  createdAt: Number(r.created_at),
});

const toOutage = (r: Row): OutageRow => ({
  id: Number(r.id),
  start: Number(r.start),
  end: r.end === null ? null : Number(r.end),
  startApprox: !!r.start_approx,
  startSoc: r.start_soc ?? null,
  endSoc: r.end_soc ?? null,
  missingPhases: r.missing_phases,
});

export class Repo {
  constructor(private db: Database) {}

  insertReading(r: Reading): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO readings (ts, json) VALUES (?, ?)').run(r.ts, JSON.stringify(r));
    return Number(res.changes) > 0;
  }

  /** Live readings are complete; they replace a same-ts history row (history has only 5 fields). Returns true if ts is new. */
  upsertReading(r: Reading): boolean {
    const existed = !!this.db.prepare('SELECT 1 FROM readings WHERE ts = ?').get(r.ts);
    this.db.prepare('INSERT INTO readings (ts, json) VALUES (?, ?) ON CONFLICT(ts) DO UPDATE SET json = excluded.json').run(r.ts, JSON.stringify(r));
    return !existed;
  }

  latestReading(): Reading | null {
    const row = this.db.prepare('SELECT json FROM readings ORDER BY ts DESC LIMIT 1').get() as Row | undefined;
    return row ? (JSON.parse(row.json) as Reading) : null;
  }

  readingsBetween(from: number, to: number): Reading[] {
    return (this.db.prepare('SELECT json FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts').all(from, to) as Row[]).map(
      (r) => JSON.parse(r.json) as Reading,
    );
  }

  openOutage(startTs: number, approx: boolean, soc: number | null, missing: string[]): void {
    // Only one open outage at a time.
    this.db.prepare('UPDATE outages SET end = ? WHERE end IS NULL').run(startTs);
    this.db
      .prepare('INSERT INTO outages (start, start_approx, start_soc, missing_phases) VALUES (?, ?, ?, ?)')
      .run(startTs, approx ? 1 : 0, soc, missing.join(','));
  }

  hasOpenOutage(): boolean {
    return !!this.db.prepare('SELECT 1 FROM outages WHERE end IS NULL LIMIT 1').get();
  }

  closeOutage(endTs: number, soc: number | null): void {
    this.db.prepare('UPDATE outages SET end = ?, end_soc = ? WHERE end IS NULL').run(endTs, soc);
  }

  lastClosedOutage(): OutageRow | null {
    const row = this.db.prepare('SELECT * FROM outages WHERE end IS NOT NULL ORDER BY end DESC LIMIT 1').get() as Row | undefined;
    return row ? toOutage(row) : null;
  }

  outagesOverlapping(from: number, to: number): OutageRow[] {
    return (
      this.db.prepare('SELECT * FROM outages WHERE start < ? AND (end IS NULL OR end > ?) ORDER BY start').all(to, from) as Row[]
    ).map(toOutage);
  }

  insertGap(from: number, to: number): void {
    if (to > from) this.db.prepare('INSERT INTO gaps (start, end) VALUES (?, ?)').run(from, to);
  }

  gapsOverlapping(from: number, to: number): Interval[] {
    return (this.db.prepare('SELECT start, end FROM gaps WHERE start < ? AND end > ? ORDER BY start').all(to, from) as Row[]).map(
      (r) => ({ start: Number(r.start), end: Number(r.end) }),
    );
  }

  earliestDataTs(): number | null {
    const row = this.db.prepare('SELECT MIN(ts) AS t FROM readings').get() as Row;
    return row.t === null ? null : Number(row.t);
  }

  getState(): DetectorState | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'detector'").get() as Row | undefined;
    return row ? (JSON.parse(row.value) as DetectorState) : null;
  }

  saveState(s: DetectorState): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES ('detector', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify(s),
    );
  }

  /** `lang` applies to new rows only: a returning user keeps their choice. */
  upsertPendingUser(u: { tgId: number; name: string; username: string | null; lang: Lang }): UserRow {
    this.db
      .prepare(
        `INSERT INTO users (tg_id, name, username, status, lang, created_at) VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, username = excluded.username`,
      )
      .run(u.tgId, u.name, u.username, u.lang, Date.now());
    return this.getUser(u.tgId)!;
  }

  setUserStatus(tgId: number, s: UserStatus): void {
    this.db.prepare('UPDATE users SET status = ? WHERE tg_id = ?').run(s, tgId);
  }

  setMuted(tgId: number, muted: boolean): void {
    this.db.prepare('UPDATE users SET muted = ? WHERE tg_id = ?').run(muted ? 1 : 0, tgId);
  }

  putBatteryDay(d: BatteryDay): void {
    this.db.prepare('INSERT INTO battery_days (date, json) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET json = excluded.json').run(d.date, JSON.stringify(d));
  }

  batteryDayDates(): Set<string> {
    return new Set((this.db.prepare('SELECT date FROM battery_days').all() as Row[]).map((r) => r.date as string));
  }

  batteryDays(fromIso: string): BatteryDay[] {
    return (this.db.prepare('SELECT json FROM battery_days WHERE date >= ? ORDER BY date').all(fromIso) as Row[]).map((r) => JSON.parse(r.json));
  }

  allBatteryDays(): BatteryDay[] {
    return this.batteryDays('');
  }

  /** Keyed by the run start: a run first seen mid-outage is replaced by its longer final version. */
  putCapacityRun(r: CapacityRun): void {
    this.db.prepare('INSERT OR REPLACE INTO capacity_runs (start_ts, json) VALUES (?, ?)').run(r.startTs, JSON.stringify(r));
  }

  deleteCapacityRun(startTs: number): void {
    this.db.prepare('DELETE FROM capacity_runs WHERE start_ts = ?').run(startTs);
  }

  capacityRuns(): CapacityRun[] {
    return (this.db.prepare('SELECT json FROM capacity_runs ORDER BY start_ts').all() as Row[]).map((r) => JSON.parse(r.json));
  }

  setReminder(tgId: number, kind: 'off' | 'on', min: number): void {
    this.db.prepare(`UPDATE users SET ${kind === 'off' ? 'remind_off_min' : 'remind_on_min'} = ? WHERE tg_id = ?`).run(min, tgId);
  }

  setLang(tgId: number, lang: Lang): void {
    this.db.prepare('UPDATE users SET lang = ? WHERE tg_id = ?').run(lang, tgId);
  }

  setNightQuiet(tgId: number, on: boolean): void {
    this.db.prepare('UPDATE users SET night_quiet = ? WHERE tg_id = ?').run(on ? 1 : 0, tgId);
  }

  setWatchdog(tgId: number, on: boolean): void {
    this.db.prepare('UPDATE users SET watchdog = ? WHERE tg_id = ?').run(on ? 1 : 0, tgId);
  }

  getKv<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  energyDays(fromIso: string, toIso: string): { day: EnergyDayRaw; complete: boolean }[] {
    const rows = this.db.prepare('SELECT json, complete FROM energy_days WHERE date >= ? AND date <= ? ORDER BY date').all(fromIso, toIso) as Row[];
    return rows.map((r) => ({ day: JSON.parse(r.json) as EnergyDayRaw, complete: !!r.complete }));
  }

  putEnergyDay(day: EnergyDayRaw, complete: boolean): void {
    this.db
      .prepare('INSERT INTO energy_days (date, json, complete) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET json = excluded.json, complete = excluded.complete')
      .run(day.date, JSON.stringify(day), complete ? 1 : 0);
  }

  purgeEnergyBefore(dateIso: string): number {
    return Number(this.db.prepare('DELETE FROM energy_days WHERE date < ?').run(dateIso).changes);
  }

  counts(): { readings: number; outages: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return { readings: n('SELECT COUNT(*) AS n FROM readings'), outages: n('SELECT COUNT(*) AS n FROM outages') };
  }

  getUser(tgId: number): UserRow | null {
    const row = this.db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as Row | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(): UserRow[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(toUser);
  }

  approvedUsers(): UserRow[] {
    return (this.db.prepare("SELECT * FROM users WHERE status = 'approved' ORDER BY created_at").all() as Row[]).map(toUser);
  }

  deleteUser(tgId: number): void {
    this.db.prepare('DELETE FROM users WHERE tg_id = ?').run(tgId);
  }

  purgeOlderThan(cutoffMs: number): { readings: number; outages: number; gaps: number } {
    const n = (sql: string) => Number(this.db.prepare(sql).run(cutoffMs).changes);
    return {
      readings: n('DELETE FROM readings WHERE ts < ?'),
      outages: n('DELETE FROM outages WHERE end IS NOT NULL AND end < ?'),
      gaps: n('DELETE FROM gaps WHERE end < ?'),
    };
  }
}
