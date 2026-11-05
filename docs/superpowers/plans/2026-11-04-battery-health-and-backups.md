# Battery Health + Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner chose inline). Checkbox steps.

**Goal:** `/battery` image card (capacity estimate, cycles, wear, temperature) for all users, and daily gzip DB backups kept 90 days, without memory growth or blocking.

**Spec:** `docs/superpowers/specs/2026-11-04-battery-health-and-backups-design.md` (incl. "Decisions after the builder check").

## Global Constraints
- Pure-function vitest tests in `tests/`; no new dependencies (`node:zlib`, `node:sqlite`, `node:worker_threads`); no git commits; texts in ru/uk/en dicts; cards text-free.
- Nominal capacity = `Reading.batteryCapacityKwh ?? cfg.batteryCapacityKwh`; rated cycles env `BATTERY_RATED_CYCLES` (default 6000, 500..20000).
- Backups: `data/backups/deye-YYYY-MM-DD.db.gz`, one per date, 03:30 Kyiv + on startup if missing, delete > 90 days and `*.tmp`, no overlapping runs.
- Bot runs locally (`NODE_USE_ENV_PROXY=0 npm start`, log `tmp/local-run.log`); restart after build.

## Review Focus
1. Standby discharge at 100 % (−20…−45 W for hours) never becomes a capacity run → test (Task 2).
2. Readings with gaps > 10 min split a run; backfilled history readings without temperature don't count as 0 °C → test (Task 2/3).
3. Lifetime counter reset (lower value) doesn't produce negative cycles → test (Task 3).
4. Backup dir never holds two files for one date or > 90 dated files; tmp leftovers removed → test on pure `backupPlan` (Task 5).
5. Backup and daily job don't grow RSS / block the event loop → measure (Task 6).

### Task 1: Lifetime counters in Reading
Files: `src/deye/types.ts`, `src/deye/official.ts`; Test `tests/official-map.test.ts`.
Produces: `Reading.dischargeTotalKwh: number | null`, `Reading.chargeTotalKwh: number | null` mapped from `TotalDischargeEnergy` / `TotalChargeEnergy`; `emptyReading` sets null.
- [ ] Failing test: inline latest with those keys → 10.8 / 18.1. → implement → pass.

### Task 2: Capacity runs (pure)
Files: Create `src/domain/battery.ts`; Test `tests/battery.test.ts`.
Produces: `interface CapacityRun { startTs; endTs; socFrom; socTo; energyKwh; estimateKwh }`; `findCapacityRuns(readings: Reading[], minDropPct = 20, maxGapMs = 10 * 60_000): CapacityRun[]` — runs of discharge (batteryPowerW < 0) starting at the last reading before SOC begins to fall, ending at the last reading where SOC fell; split on gaps > maxGap or charge; energy = left Riemann sum of −batteryPowerW × Δt; estimate = energy / (drop / 100); `capacitySummary(runs: CapacityRun[], nominalKwh: number, nowMs: number): { estimateKwh: number | null; pct: number | null; trendPct: number | null }` — median of last 5; trend = median(last 30 d) vs median(30–60 d) in percentage points.
- [ ] Failing tests: synthetic outage 80→50 % at 2 kW for (0.3 × 23.55 / 2) h → estimate ≈ 23.55 (±2 %); hours of −30 W at SOC 100 then a 60→35 % discharge → one run starting at SOC 60; a 15-min gap splits the run (both < 20 % → none); drop 15 % → none; median of 5 with an outlier.
- [ ] Implement → pass.

### Task 3: Daily aggregates + wear (pure)
Files: `src/domain/battery.ts`; Test `tests/battery.test.ts`.
Produces: `interface BatteryDay { date; maxTempC: number | null; avgTempC: number | null; minAbove35: number; minAboveLimit: number; minSoc: number | null; maxSoc: number | null; dischargeTotalKwh: number | null; chargeTotalKwh: number | null }`; `aggregateDay(dateIso, readings, limitC, zone): BatteryDay` (minutes = Δt to next reading, capped 10 min; readings with null temp ignored); `lifetimeDischargeKwh(days: BatteryDay[], latest: number | null): number` (sums positive deltas of the day-end counter, a drop = reset → continue from the new value); `wear(cycles, ratedCycles, estimateKwh, nominalKwh): { byCyclesPct; byCapacityPct: number | null }` (capacity wear clamped ≥ 0).
- [ ] Failing tests: minutes above 35 with 3-min spacing; null temps ignored; counters 5, 9, 2 (reset), 6 → lifetime 13 (+ latest); wear 48/6000 = 0.8 %; estimate above nominal → 0 %.
- [ ] Implement → pass.

### Task 4: Storage, daily job, card, command
Files: `src/storage/db.ts` (migration: `battery_days`, `capacity_estimates`), `src/storage/repo.ts` (`putBatteryDay`, `batteryDays(fromIso)`, `putCapacityRun` INSERT OR IGNORE, `capacityRuns()`), Create `src/battery-health.ts` (`BatteryHealth` service: `start()` — on start aggregate every day in `readings` without a row, then scan runs over the last 48 h; a timer at 00:10 Kyiv for yesterday + runs; `stop()`), `src/config.ts` (`batteryRatedCycles`), `src/render/models.ts` (`batteryModel(...)`), `src/render/cards.ts` (`svgBattery`), `src/bot/bot.ts` (`/battery`, `bat:show`), `src/bot/keyboards.ts` (menu), dicts; Test `tests/models.test.ts`, `tests/config.test.ts`.
- [ ] Failing tests: `batteryModel` with no runs → capacity tile "ще мало даних…"; with runs → "≈ 22.8 кВт·год · 97 %"; cycles/wear texts; temp tile; config `BATTERY_RATED_CYCLES` default 6000 and range.
- [ ] Implement → pass; preview PNGs uk/ru/en checked with Read.

### Task 5: Backups
Files: Create `src/backup.ts` (pure `backupPlan(files: string[], todayIso: string, keepDays = 90): { needToday: boolean; remove: string[] }`; `runBackup(dbPath, dir, todayIso)` — worker thread: second `DatabaseSync` → `VACUUM INTO tmp`; then `pipeline(createReadStream(tmp), createGzip(), createWriteStream(gzTmp))`, rename, unlink tmp; class `Backups { start(); stop() }` — startup check + 03:30 daily, `running` guard, admin notice once per day on failure); `src/main.ts` wiring; dicts; Test `tests/backup.test.ts`.
- [ ] Failing tests for `backupPlan`: today present → needToday false; old files (> 90 d) and `*.tmp` removed; unrelated files untouched; two names for one date impossible (input with today → no new).
- [ ] Implement → pass.

### Task 6: Verify, review, restart
- [ ] Throwaway script: run `runBackup` 5× on a copy of `data/deye.db` (same date) → one file; RSS before/after; event loop lag during backup (setInterval drift) < 100 ms.
- [ ] Full suite, typecheck, build; fresh final reviewer (most capable model) incl. Review Focus; fix Critical/Important with tests.
- [ ] Rebuild, restart the local bot, `/battery` check, backup file appears in `data/backups/`.
