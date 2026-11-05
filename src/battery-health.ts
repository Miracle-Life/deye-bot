// Battery health: daily summaries and capacity runs into small permanent tables; data for /battery.
import { DateTime } from 'luxon';
import type { Config } from './config.js';
import { aggregateDay, capacitySummary, findCapacityRuns, lifetimeDischargeKwh, mergeRuns, wear } from './domain/battery.js';
import { errInfo, log } from './log.js';
import type { BatteryHealthData } from './render/models.js';
import type { Repo } from './storage/repo.js';

const H = 3_600_000;
const DAY = 24 * H;
const FIRST_SCAN_CHUNK_DAYS = 7; // bounded memory on the first full scan

export class BatteryHealth {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private repo: Repo,
    private cfg: Config,
  ) {}

  start(): void {
    // Off the startup path; then every night shortly after midnight.
    this.timer = setTimeout(() => this.run(true), 5_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(first: boolean): void {
    try {
      this.catchUpDays();
      this.scanRuns(first && this.repo.capacityRuns().length === 0);
    } catch (e) {
      log.warn('battery health update failed', errInfo(e));
    }
    const z = this.cfg.timezone;
    const next = DateTime.now().setZone(z).plus({ days: 1 }).startOf('day').plus({ minutes: 10 }).toMillis();
    this.timer = setTimeout(() => this.run(false), Math.max(60_000, next - Date.now()));
  }

  /** Summaries for every finished day that has readings but no row yet (first run backfills up to 90 days). */
  private catchUpDays(): void {
    const z = this.cfg.timezone;
    const earliest = this.repo.earliestDataTs();
    if (earliest === null) return;
    const today = DateTime.now().setZone(z).startOf('day');
    // Yesterday is always redone: it may have been summarized before the history backfill finished.
    const have = this.repo.batteryDayDates();
    have.delete(today.minus({ days: 1 }).toISODate()!);
    for (let d = DateTime.fromMillis(earliest, { zone: z }).startOf('day'); d < today; d = d.plus({ days: 1 })) {
      const iso = d.toISODate()!;
      if (have.has(iso)) continue;
      const rs = this.repo.readingsBetween(d.toMillis(), d.plus({ days: 1 }).toMillis());
      if (rs.length) this.repo.putBatteryDay(aggregateDay(iso, rs, this.cfg.batteryTempMaxC));
    }
  }

  /** Capacity runs: the last 48 h normally; everything in weekly chunks (1-day overlap) the first time. */
  private scanRuns(all: boolean): void {
    const now = Date.now();
    const from = all ? (this.repo.earliestDataTs() ?? now) : now - 2 * DAY;
    for (let a = from; a < now; a += (FIRST_SCAN_CHUNK_DAYS - 1) * DAY) {
      const found = findCapacityRuns(this.repo.readingsBetween(a, Math.min(now + 1, a + FIRST_SCAN_CHUNK_DAYS * DAY)));
      const m = mergeRuns(this.repo.capacityRuns(), found);
      for (const ts of m.remove) this.repo.deleteCapacityRun(ts);
      for (const r of m.put) this.repo.putCapacityRun(r);
    }
  }

  /** Everything the /battery card shows; reads only the small tables plus today's readings. */
  data(nowMs = Date.now()): BatteryHealthData {
    const z = this.cfg.timezone;
    // Right after startup the newest reading may be a history one (no temperature/counters/capacity).
    const recent = this.repo.readingsBetween(nowMs - DAY, nowMs + 1).reverse();
    const lastOf = <T>(f: (r: (typeof recent)[number]) => T | null) => recent.map(f).find((v) => v !== null && v !== undefined) ?? null;
    const latest = { batteryCapacityKwh: lastOf((r) => r.batteryCapacityKwh), dischargeTotalKwh: lastOf((r) => r.dischargeTotalKwh || null), batteryTempC: lastOf((r) => r.batteryTempC) };
    const nominal = latest.batteryCapacityKwh ?? this.cfg.batteryCapacityKwh;
    const capacity = capacitySummary(this.repo.capacityRuns(), nominal, nowMs);
    const todayStart = DateTime.fromMillis(nowMs, { zone: z }).startOf('day');
    const today = aggregateDay(todayStart.toISODate()!, this.repo.readingsBetween(todayStart.toMillis(), nowMs + 1), this.cfg.batteryTempMaxC);
    const all = this.repo.allBatteryDays();
    const last30 = [...all.filter((d) => d.date >= todayStart.minus({ days: 29 }).toISODate()!), today];
    // A day can't discharge more than ~3 full capacities: bigger jumps are glitches.
    const cycles = lifetimeDischargeKwh(all, latest.dischargeTotalKwh ?? today.dischargeTotalKwh, 3 * nominal) / nominal;
    const temps = last30.map((d) => d.maxTempC).filter((v): v is number => v !== null);
    return {
      nominalKwh: nominal,
      capacity,
      cycles,
      ratedCycles: this.cfg.batteryRatedCycles,
      wear: wear(cycles, this.cfg.batteryRatedCycles, capacity.estimateKwh, nominal),
      tempNow: latest.batteryTempC,
      tempMax30: temps.length ? Math.max(...temps) : null,
      hoursAbove35: last30.reduce((a, d) => a + d.minAbove35, 0) / 60,
      hoursAboveLimit: last30.reduce((a, d) => a + d.minAboveLimit, 0) / 60,
      limitC: this.cfg.batteryTempMaxC,
      today: todayStart.toISODate()!,
      days: last30.map((d) => ({ date: d.date, maxTempC: d.maxTempC })),
    };
  }
}
