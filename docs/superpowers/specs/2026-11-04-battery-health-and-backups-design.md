# Deye bot: battery health card + database backups — design

Date: 2026-11-04. Extends the live bot (see earlier specs in this folder).

## Why

1. **Battery health.** The owner wants to know, roughly once a month: are the batteries losing capacity, do they overheat, how many cycles so far, and approximately how worn they are. Shown as an image card `/battery`, visible to everyone (owner's decision).
2. **Backups.** If the SQLite DB gets corrupted, all outage/money history is lost. Daily backups, kept at most 90 days (owner). Owner's explicit concern: no memory leaks, no duplicate/runaway DB files, nothing slow.

## Data available (Deye official API, verified in the 2026-11-04 dump)

- `TotalDischargeEnergy` / `TotalChargeEnergy` — lifetime battery counters, kWh (not yet mapped into `Reading`).
- `SOC`, `BatteryPower` (already `Reading.soc`, `Reading.batteryPowerW`, >0 = charging), `Temperature- Battery` (`Reading.batteryTempC`), `BatteryRatedCapacity` 460 Ah → nominal ≈ 23.55 kWh (`Reading.batteryCapacityKwh`, 51.2 V nominal).
- No state-of-health (SOH) field — health must be estimated.
- Readings arrive every ~3–5 min (logger frames); raw readings are kept 90 days.

## Battery health

### Metrics
- **Cycles ≈ lifetime discharge kWh / nominal kWh** (equivalent full cycles), e.g. "≈ 48 циклів".
- **Wear by cycles ≈ cycles / rated cycle life.** Rated life: **6000 cycles** (typical LiFePO4 spec; my call), configurable via env `BATTERY_RATED_CYCLES`.
- **Real capacity estimate** from deep discharges: a discharge run = consecutive readings with `batteryPowerW < 0`, gaps between readings ≤ 10 min (longer gap ends the run), SOC drop ≥ **20 points**. Energy = Σ(−batteryPowerW × Δt) over the run (trapezoid or left sum — builder's call). Estimate = energy / (ΔSOC / 100). Store each estimate. Shown value = **median of the last 5 estimates**; trend = median of estimates in the last 30 days vs the 30 days before (when both exist).
- **Wear by capacity ≈ 1 − estimate / nominal**, never shown below 0 % (estimates above nominal are clamped for the wear figure but the raw kWh is shown).
- **Temperature:** current, max over the last 30 days, hours above 35 °C and hours above the configured limit (`batteryTempMaxC`, default 45) over the last 30 days, plus a 30-day bar chart of daily max temperature.
- Everything is labelled approximate ("≈", "оцінка").
- Not enough data yet (no deep discharge recorded): capacity tile says "ще мало даних — потрібен розряд ≥ 20 %".

### Storage (small, permanent)
- New table `battery_days(date TEXT PRIMARY KEY, json TEXT)`: per local day — max/avg temperature, minutes above 35 °C and above the limit, lifetime discharge/charge counters at end of day, min/max SOC. **Kept forever** (≈ 365 rows/year, a few KB).
- New table `capacity_estimates(start_ts INTEGER PRIMARY KEY, json TEXT)`: start/end ts, SOC from/to, energy kWh, estimate kWh. Primary key on the run start prevents duplicates when the same run is seen twice. Kept forever (a few per month).
- Daily aggregation job: once per day for the finished day (and on startup for every day present in `readings` that has no `battery_days` row yet — backfills up to 90 days the first time). Capacity runs are scanned over the last 48 h each time (idempotent thanks to the PK).
- `/battery` renders only from these small tables + the latest reading → instant.

### Card `/battery` (image, all users, i18n uk/ru/en)
Title "Здоров'я батарей" + "оцінка за даними Deye". Tiles: capacity (≈ kWh, % of nominal, trend arrow), cycles, wear (by cycles · by capacity), temperature (now / 30-day max / hours above 35 °C and above limit). Bottom: 30 daily-max-temperature bars with a line at 35 °C and at the limit. Keyboard: 🏠. Added to the command menu.

## Backups

- Every day at **03:30** Kyiv (my call — quiet time) and once on startup if today's backup is missing.
- Method: `VACUUM INTO '<dir>/deye-YYYY-MM-DD.db.tmp'` (SQLite writes a consistent copy straight to disk; no JS memory), then **gzip via streams** to `deye-YYYY-MM-DD.db.gz.tmp`, then rename to `deye-YYYY-MM-DD.db.gz`, delete the raw tmp. Gzip: the DB compresses ~4–5×, so 90 copies of a ~20 MB DB ≈ 350–450 MB (my call; restore = `gunzip`).
- **Exactly one file per date**: if `deye-<today>.db.gz` exists, skip. Atomic rename means a crash never leaves a half file under the final name.
- **Retention 90 days**: after each backup delete `deye-*.db.gz` older than 90 days by the date in the name, and any `*.tmp` left by an interrupted run.
- Directory `data/backups/` (inside the mounted volume, so the NAS keeps it; Hyper Backup can take it further).
- Runs async off the poll path (no blocking of Telegram/Deye handling); a failure logs + tells the admin once per day; success logs file size.
- No overlap: a second run while one is in progress is skipped.

## Non-goals
- Restoring from a backup via the bot (manual: stop container, gunzip, replace `data/deye.db`).
- Off-NAS/cloud backups. Battery control. Per-cell / per-module data (not available).

## Constraints
- Same project rules: pure-function vitest tests; exact npm pins if any dependency (none expected: `node:zlib`, `node:sqlite`); no git commits; all texts in the three dictionaries; cards text-free.
- Verify no memory growth from backups and the health job (measure RSS like the resvg fix), and that the backup dir never exceeds 90 dated files + no tmp leftovers.

## Left to the builder
- Card layout metrics, exact energy integration (left sum vs trapezoid), where the daily jobs are scheduled (a small scheduler or existing timers), `BATTERY_RATED_CYCLES` validation range.

## Decisions after the builder check
- Batteries were new with this inverter (owner): no cycles offset; the lifetime counter starts at ~0. Counter resets (inverter replaced/reset) are handled: a day-end counter lower than the previous day's is treated as a reset and the lifetime total keeps accumulating (my call).
- `/battery` is on demand only (no monthly push).
- Discharge runs start where SOC actually begins to fall (standby −20…−45 W at 100 % must not inflate the estimate) and end where it stops falling or discharge ends (builder's call, accepted).
- `VACUUM INTO` runs on a separate connection in a worker thread so the bot never blocks (node:sqlite is synchronous).
- Temperatures and lifetime counters come from live readings only (history backfill carries only SOC/battery power/grid voltages).
