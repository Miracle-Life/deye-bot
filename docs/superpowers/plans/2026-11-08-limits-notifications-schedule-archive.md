# Power limits, outage panels, schedule archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real power limits on the panel (80 A grid charge, derated battery output, 10 kW scale), kW with two decimals, a battery-overload alert, outage notifications that are the normal live panel, and a 90-day YASNO schedule archive with week / month / 3-month cards.

**Architecture:** Pure logic stays in `src/domain/*` and `src/schedule/*`, view-models + SVG in `src/render/*`, wiring in `src/bot/bot.ts` / `src/main.ts` / `src/monitor.ts`, exactly like today. The archive gets its own pure module (`src/schedule/archive.ts`) and its own render module (`src/render/archive.ts`) so `models.ts` / `cards.ts` don't grow.

**Tech Stack:** TypeScript (ESM), grammY, node:sqlite, resvg, luxon, vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-limits-notifications-schedule-archive-design.md`

## Global Constraints

- No new runtime dependencies.
- Every user-facing string exists in `src/i18n/uk.ts`, `ru.ts`, `en.ts` (type `Dict` from `ru.ts` enforces the shape).
- Callback data is language-independent (`sa:w:2026-11-02`, `sa:m:2026-10`, `sa:q:2026-11-08`).
- kW = two decimals (`4.25 кВт`); below 1000 W → whole watts; kWh and volts unchanged.
- Every variable text on a card goes through `fitFont` or is shortened to fit; nothing may overlap in uk/ru/en.
- Commits: author `Denys Bielov`, **no** `Co-Authored-By` / Claude attribution of any kind.
- No personal data in the repo (mock addresses/IDs only in tests and scripts).
- Run `npm test` and `npm run typecheck` before every commit; both must pass.

## Review Focus

1. Outage that starts before a day/week and is still open now → actual hours are clipped to the day and to *now*, never negative, never > 24 h. (Task 7 test `actual hours clip open outage`.)
2. DST day (2026-10-25, 25 h; 2026-03-29, 23 h) in week/month cards → bars span the real day length, no crash, hours add up. (Task 7 test `DST days`.)
3. Notification with the panel photo when the photo upload fails → falls back to text **with** the panel keyboard and is not tracked live. (Task 5 test `photo fallback keeps keyboard`.)
4. Battery threshold above the computed scale (threshold 8 kW, scale 7.9 kW at low voltage) → red zone starts at the scale end, alert still fires at the threshold. (Task 2 test `threshold above scale`.)
5. Archive navigation past the oldest stored day or into the future → `‹` / `›` hidden, a stale button from an old message renders the nearest valid period instead of crashing. (Task 9 test `clamps out-of-range anchors`.)

---

### Task 1: kW with two decimals

**Files:**
- Modify: `src/bot/format.ts:62-64` (`fmtPower`), add `fmtKw`
- Modify: `src/render/models.ts` (replace `kw1`), `src/bot/ops-format.ts` (replace `kw1`)
- Test: `tests/format.test.ts`

**Interfaces:**
- Produces: `fmtKw(w: number): string` — `(w/1000).toFixed(2)`, no unit; `fmtKwMax(w: number): string` — whole kW without decimals (`'10'`), else two decimals (`'8.47'`). `fmtPower(w, t)` → `'4.25 кВт'` / `'682 Вт'`.

- [ ] **Step 1: Failing tests** in `tests/format.test.ts`:
  `fmtPower(4250, uk) === '4.25 кВт'`, `fmtPower(999, uk) === '999 Вт'`, `fmtPower(1000, uk) === '1.00 кВт'`, `fmtPower(-3230, en) === '3.23 kW'`, `fmtKw(8432) === '8.43'`, `fmtKwMax(10000) === '10'`, `fmtKwMax(8470) === '8.47'`.
- [ ] **Step 2:** `npx vitest run tests/format.test.ts` → FAIL (`fmtKw` not exported / `4.3 кВт`).
- [ ] **Step 3:** Implement in `format.ts`; replace every `kw1(...)` in `models.ts` and `ops-format.ts` with `fmtKw(...)`; remove both `kw1` helpers. Update existing test expectations that assert one-decimal kW (`models.test.ts`, `format.test.ts`, `ops-format.test.ts`) to the two-decimal values.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: show kW with two decimals`.

### Task 2: Real limits on the load bar + settings

**Files:**
- Modify: `src/domain/load.ts`, `src/config.ts`, `src/settings.ts`, `src/render/models.ts` (`gridBlock`, `batteryBlock`), `src/i18n/{uk,ru,en}.ts` (`card.chargeLimit`, `card.dischargeLimit`, `cfg.fields`), `.env.example`, `README.md` (config table)
- Test: `tests/load.test.ts`, `tests/models.test.ts`, `tests/config.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Consumes: `fmtKw`, `fmtKwMax` (Task 1).
- Produces (all in `load.ts`):
  - `DEFAULT_RATED_W = 10_000`, `BATTERY_DERATE = 0.89`, `GRID_YELLOW_W = 5000`, `GRID_ORANGE_W = 6500`; remove `BREAKER_W`, `YELLOW_FROM_W`, `ORANGE_FROM_W`, `BATTERY_BANDS`.
  - `gridScaleW(ratedW: number | null): number` → `ratedW > 0 ? ratedW : 10000`.
  - `loadZone(w, redFromW)` unchanged signature; yellow 5000, orange 6500, each capped at `redFromW`.
  - `batteryScaleW(dischargeA: number | null, batteryV: number, ratedW: number | null): number` → `min(rated, round(dischargeA × V × 0.89))`, rated fallback 10000, dischargeA null/0 → rated.
  - `batteryBands(scaleW: number, redFromW: number): { yellow: number; orange: number; red: number }` — fractions of the scale: yellow 0.5, orange 0.7, red `min(1, redFromW/scaleW)`; yellow/orange capped at red.
  - `batteryZone(w: number, scaleW: number, redFromW: number): LoadZone` — red ≥ `min(redFromW, scaleW)`, orange ≥ 0.7×scale, yellow ≥ 0.5×scale (both capped at the red start).
  - `gridChargeW(gridChargeA: number, batteryV: number): number` → `round(A × V)`.
- Config (`config.ts`): `gridLoadMaxKw` default **8**; new `gridChargeA` (env `GRID_CHARGE_A`, default 80, valid 10..300) and `batteryLoadMaxKw` (env `BATTERY_LOAD_MAX_KW`, default 7, valid 1..20).
- Settings (`settings.ts`): `Tunable` += `'gridChargeA' | 'batteryLoadMaxKw'`; `Unit` += `'a'` (renders ` A`); fields in section `load`:
  `gridLoadMaxKw` options `[7, 7.5, 8, 8.5, 9, 9.5]`; `batteryLoadMaxKw` options `[6, 6.5, 7, 7.5, 8]` unit `kw`; `gridChargeA` options `[40, 50, 60, 70, 80, 90, 100, 120, 150]` unit `a`.
- i18n copy (uk shown; ru/en equivalent):
  - `card.chargeLimit(a, kw)` → `ліміт заряду з мережі ${a} А ≈ ${kw} кВт`
  - `card.dischargeLimit(a, kw, inverterKw)` keeps its shape; `kw` is now the derated figure.
  - `cfg.fields.gridLoadMaxKw.label` → `Попереджати від (світло є)`; `batteryLoadMaxKw` → `Попереджати від (світла немає)`, hint `сповіщення лише власнику; відбій — на 0.5 кВт нижче`; `gridChargeA` → label `Струм заряду від мережі`, hint `як на інверторі: Batt set2 → Grid Charge (хмара Deye його не віддає)`.

- [ ] **Step 1: Failing tests** in `tests/load.test.ts`: `batteryScaleW(180, 53.1, 10000) === 8507`; `batteryScaleW(180, 50, 10000) === 8010`; `batteryScaleW(null, 53, 10000) === 10000`; `batteryScaleW(180, 53, null) === 8491`; `gridScaleW(null) === 10000`; `loadZone(5200, 8000) === 'yellow'`, `loadZone(6600, 8000) === 'orange'`, `loadZone(8000, 8000) === 'red'`; `batteryZone(7000, 8500, 7000) === 'red'`, `batteryZone(4300, 8500, 7000) === 'yellow'`; **threshold above scale**: `batteryZone(7900, 7900, 8000) === 'red'` and `batteryBands(7900, 8000).red === 1`.
- [ ] **Step 2:** In `tests/models.test.ts`: grid-on panel with `gridPowerW 8432, batteryPowerW 4154, batteryVoltage 54.84`, `cfg.gridChargeA = 80` → `load.max === '10 kW'`, `legend.limit === 'grid charge limit 80 A ≈ 4.39 kW'` (en), `zone === 'red'` with `gridLoadMaxKw 8`; outage panel with `upsLoadPowerW 1000, batteryVoltage 53.1`, limits `{chargeA:150, dischargeA:180}`, `ratedPowerW 10000` → `load.max === '8.51 kW'`, legend contains `180 A ≈ 8.51 kW`.
- [ ] **Step 3:** `tests/config.test.ts`: defaults `gridLoadMaxKw 8`, `gridChargeA 80`, `batteryLoadMaxKw 7`; `GRID_CHARGE_A=5` throws. `tests/settings.test.ts`: the three fields exist in section `load` with the option lists above.
- [ ] **Step 4:** Run `npx vitest run tests/load.test.ts tests/models.test.ts tests/config.test.ts tests/settings.test.ts` → FAIL.
- [ ] **Step 5:** Implement. `gridBlock(r, cfg, t)` no longer takes `chargeA`; scale = `gridScaleW(r.ratedPowerW)`; legend from `cfg.gridChargeA` and `r.batteryVoltage ?? NOMINAL_BATTERY_V`. `batteryBlock(r, dischargeA, cfg, t)` uses `batteryScaleW`, `batteryBands`, `batteryZone` with `cfg.batteryLoadMaxKw*1000`. Bar max label via `fmtKwMax`. Update `.env.example` (`GRID_LOAD_MAX_KW=8`, add `GRID_CHARGE_A=80`, `BATTERY_LOAD_MAX_KW=7` with one-line comments) and README config table (rows for the two new vars, `GRID_LOAD_MAX_KW` default 8 and text "red zone and alert from this grid draw; the scale is the inverter's rated power (10 kW)").
- [ ] **Step 6:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 7:** Commit `feat: real grid-charge and battery limits on the load bar`.

### Task 3: Battery overload alert

**Files:**
- Modify: `src/domain/load.ts` (add step fn), `src/domain/watch.ts` (`WatchState`, `WatchEvent`), `src/monitor.ts:onReading`, `src/bot/ops-format.ts` (`renderWatch`; drop `BREAKER_W` from `grid_high` note), `src/i18n/{uk,ru,en}.ts` (`watch.batteryHigh`, `watch.batteryHighNote`, `watch.batteryOk`, `watch.gridHighNote`)
- Test: `tests/load.test.ts`, `tests/ops-format.test.ts`

**Interfaces:**
- Consumes: `batteryScaleW` (Task 2).
- Produces:
  - `batteryWatchStep(high: boolean, grid: 'on'|'off'|null, loadW: number | null, thresholdW: number): { high: boolean; event: 'high'|'ok'|null }` — grid `'on'` → `{high:false, event:null}` (silent reset); grid `'off'` → `stepGridLoad` semantics (hysteresis 500 W); `null` grid or load → unchanged.
  - `WatchState.batteryHigh: boolean` (default `false`; old stored states without it read as `false`).
  - `WatchEvent` += `{ type: 'battery_high'; loadW: number; limitW: number; scaleW: number } | { type: 'battery_ok'; loadW: number }`.
  - Copy (uk): `batteryHigh: (kw) => '⚠️ Від батарей ${kw} кВт'`, `batteryHighNote: (limit, scale) => 'поріг ${limit} кВт · інвертор може віддати ≈ ${scale} кВт'`, `batteryOk: (kw) => '✅ Від батарей ${kw} кВт — навантаження в нормі'`; `gridHighNote(home, bat, limit, scale)` → `будинок … + батареї … · поріг ${limit} кВт · максимум ${scale} кВт`.
- [ ] **Step 1: Failing tests**: `batteryWatchStep(false,'off',7000,7000)` → `{high:true,event:'high'}`; `(true,'off',6600,7000)` → no event; `(true,'off',6400,7000)` → `'ok'`; `(true,'on',9000,7000)` → `{high:false,event:null}`. `renderWatch({type:'battery_high',loadW:7120,limitW:7000,scaleW:8510}, z, uk).text` contains `7.12` and `8.51`, `silent === false`; `battery_ok` is silent.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; in `Monitor.onReading` after the grid step: load = `r.upsLoadPowerW ?? r.loadPowerW`, threshold `cfg.batteryLoadMaxKw*1000`, scale from `batteryScaleW(this.batteryLimits?.dischargeA ?? null, r.batteryVoltage ?? NOMINAL_BATTERY_V, r.ratedPowerW)`; audience **`'all'`** (owner's decision: everyone gets it; `battery_high` is loud so it carries the panel photo + keyboard, `battery_ok` is silent text). Monitor gets the limits via a new optional constructor arg / setter `limits: () => BatteryLimits | null` wired in `main.ts` from `batteryLimits.get()`.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: alert when the house draws too much from the batteries`.

### Task 4: Don't count startup network errors

**Files:**
- Modify: `src/domain/ops.ts` (pure fn), `src/monitor.ts:onPoll`
- Test: `tests/ops.test.ts`

**Interfaces:**
- Produces: `STARTUP_GRACE_MS = 120_000`; `isStartupNetError(error: string, startedAtMs: number, nowMs: number): boolean` — true when `now - startedAt < 120000` and `error` matches `/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i`.
- [ ] **Step 1: Failing tests**: `'fetch failed: EAI_AGAIN getaddrinfo EAI_AGAIN eu1-developer.deyecloud.com'` at +30 s → true; same at +5 min → false; `'Deye /device/latest: HTTP 500'` at +30 s → false.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; in `onPoll`, when `!o.ok && isStartupNetError(o.error, this.startedAt, now)` → `log.warn('poll failed during startup', { error })` and skip `noteError` (cloud-down tracking via `stepCloud` stays as is). `startedAt` = time `Monitor` was constructed.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `fix: startup DNS errors are warnings, not bot errors`.

### Task 5: Outage notifications are the live panel

**Files:**
- Modify: `src/bot/format.ts` (`Msg`, `renderEvent`, `PanelCtx`), `src/render/models.ts` (`panelModel` caption), `src/bot/notifier.ts` (`broadcast`), `src/bot/bot.ts` (return `panelCard`, `trackLive`, `panelKbFor`; `panelCtx` fills the new field), `src/main.ts` (`send`, reminders), `src/i18n/{uk,ru,en}.ts` (`panel.wasOff`)
- Test: `tests/notifier.test.ts`, `tests/models.test.ts`, `tests/format.test.ts`

**Interfaces:**
- Produces:
  - `Msg` += `panel?: true` (deliver the panel card itself: its photo, caption, keyboard; track live) and `kb?: InlineKeyboard` (attach to whatever is sent).
  - `broadcast(api, users, msg, onBlocked, quietHour?, onSent?: (tgId: number, messageId: number, asPhoto: boolean) => void)`; `SendApi` opts gain `reply_markup?: InlineKeyboard`; `sendMessage`/`sendPhoto` return `{ message_id: number; photo?: ... }`.
  - `PanelCtx.lastOutage: { start: number; end: number } | null` (replaces `lastOnTs`; update callers).
  - `panelModel` caption: when grid `'on'` and `nowMs - lastOutage.end < 3_600_000` → `t.panel.powerOn + t.panel.wasOff(fmtDuration(end-start))` (+ charging suffix as today). uk `wasOff: (d) => ' · не було ${d}'`, ru `' · не было ${d}'`, en `' · was off ${d}'`.
  - `createBot(...)` returns additionally `panelCard(lang: Lang): { png: Buffer; caption: string; kb: InlineKeyboard }` and `trackLive(chatId: number, messageId: number, lang: Lang): void`, `panelKb(lang: Lang): InlineKeyboard`.
  - `renderEvent` for `outage_started` / `outage_ended` returns `{ text: <old text>, silent: false, panel: true }` (old text = text fallback only).
- [ ] **Step 1: Failing tests**:
  - notifier: `broadcast` with `{text:'cap', silent:false, photo:buf, kb}` passes `reply_markup === kb` to `sendPhoto` and calls `onSent(1, <id>, true)`; **photo fallback keeps keyboard**: with `photoFails`, `sendMessage` receives `reply_markup === kb` and `onSent(…, false)`.
  - models: `panelModel` with grid on, `lastOutage {start: now-4h, end: now-10min}` → caption `🟢 <b>Світло є</b> · не було 3 год 50 хв` (uk); with `end: now-61min` → no suffix.
  - format: `renderEvent(outage_started…)` has `panel === true`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. In `main.ts` `send`: per language, if `msg.panel` → `const c = panelCard(lang)`; broadcast `{ text: c.caption, silent:false, photo: c.png, kb: c.kb }` with `onSent = (id, mid, asPhoto) => asPhoto && trackLive(id, mid, lang)`; if the card render throws → fall back to `{...msg, kb: panelKb(lang)}`. Other loud `who==='all'` messages: as today plus `kb: panelKb(lang)`, not tracked. Reminders (`tickReminders` callback): `{...msg, kb: panelKb(u.lang)}`. Technical/silent messages unchanged.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: outage notifications arrive as the live panel with its buttons`.

### Task 6: Schedule archive storage

**Files:**
- Create: `src/schedule/archive.ts` (pure merge + types)
- Modify: `src/storage/db.ts` (migration), `src/storage/repo.ts`, `src/schedule/service.ts` (`fetch`, new `seedArchive()`), `src/poller.ts:purge`, `src/main.ts` (call `schedule.seedArchive()` before `schedule.start()`)
- Test: `tests/schedule-archive.test.ts` (new), `tests/schedule.test.ts`

**Interfaces:**
- Produces:
  - `interface ArchivedDay { date: string; group: string; status: DayStatus; outages: Span[]; plannedOutages: Span[]; updatedAt: number | null; fetchedAt: number }` — `plannedOutages` = last `applies` outages (equals `outages` while `applies`; kept when the day turns `emergency`).
  - `mergeArchivedDay(old: ArchivedDay | null, incoming: ArchivedDay): ArchivedDay` — `waiting`/`unknown` never replace `applies`/`emergency` (return `old`); `emergency` over `applies` keeps `old.plannedOutages`; otherwise `incoming` (with `plannedOutages = outages` when `applies`).
  - `toArchivedDays(s: Schedule): ArchivedDay[]`.
  - Migration: `CREATE TABLE schedule_days (date TEXT PRIMARY KEY, json TEXT NOT NULL);`
  - Repo: `getScheduleDay(date: string): ArchivedDay | null`, `putScheduleDay(d: ArchivedDay): void`, `scheduleDaysBetween(fromDate: string, toDate: string): ArchivedDay[]` (inclusive, sorted), `oldestScheduleDate(): string | null`; `purgeOlderThan` also deletes `schedule_days` with `date <` the cutoff's local date (pass it in: `purgeOlderThan(cutoffMs, cutoffDate)`), return key `scheduleDays`.
  - `ScheduleService.saveArchive(s: Schedule)` (called after each successful fetch: merge + put per day) and `seedArchive()` (archives `get()` if present).
- [ ] **Step 1: Failing tests** (`tests/schedule-archive.test.ts`): applies→waiting keeps applies; applies→emergency keeps `plannedOutages` and sets status `emergency`; applies→applies (new spans) replaces both; null→unknown stores unknown. Repo (in-memory db): put/get round-trip, `scheduleDaysBetween('2026-11-02','2026-11-08')` returns only that range sorted, purge removes days before cutoff date.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: keep YASNO schedules for 90 days`.

### Task 7: Archive aggregation (pure)

**Files:**
- Modify: `src/schedule/archive.ts`
- Test: `tests/schedule-archive.test.ts`

**Interfaces:**
- Consumes: `ArchivedDay` (Task 6), `buildTimeline`/`summarize`/`dayRange` from `src/domain/stats.ts`, `Interval`.
- Produces:
  - `type DayKind = 'planned' | 'emergency' | 'nodata' | 'future'`.
  - `interface ArchiveDayStat { date: string; kind: DayKind; spans: Span[]; plannedMs: number; actualMs: number | null; dayMs: number }` — `spans`/`plannedMs` from `outages` for `planned`, 0 for others; `actualMs` from the outages table clipped to the day and to `nowMs` (null for future days and days before `earliestDataTs`); `dayMs` real length (23/24/25 h).
  - `archiveStats(dates: string[], archived: Map<string, ArchivedDay>, outages: Interval[], gaps: Interval[], nowMs: number, zone: string, earliestDataTs: number | null): ArchiveDayStat[]` — `waiting`/`unknown` → `nodata`; tomorrow with an archived day → its kind; later future dates → `future`.
  - `interface PeriodTotals { plannedMs: number; actualMs: number; daysWithOutages: number; daysKnown: number; worst: { date: string; ms: number } | null }` and `totals(days: ArchiveDayStat[]): PeriodTotals` — `nodata`/`future` excluded; `emergency` adds to `actualMs` only.
  - `weekDates(anchorIso, zone)`, `monthDates(monthIso, zone)`, `quarterWeeks(anchorIso, zone): string[][]` (13 Mon–Sun weeks ending with the anchor's week).
  - `trend(weeks: PeriodTotals[]): number | null` — last 4 weeks' planned vs the 4 before, as a fraction; null if fewer than 8 weeks have `daysKnown > 0` or the base is 0.
- [ ] **Step 1: Failing tests**: day with spans 10:00–14:00 + 18:00–20:00 → `plannedMs 6h`; **actual hours clip open outage**: outage start yesterday 22:00, end null, now 09:30 → today's `actualMs === 9.5h`, yesterday's `2h`; emergency day → `plannedMs 0`, counted in `totals.actualMs`, not in `plannedMs`; waiting → `nodata` excluded from `daysKnown`; **DST days**: `dayMs` for `2026-10-25` (Europe/Kyiv) === 25h and a full-day span gives `plannedMs` 25h; `quarterWeeks('2026-11-08')` has 13 weeks, last starts `2026-11-02`; `trend` null with 7 known weeks, `0.25` for 125h vs 100h.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: archive day stats and period totals`.

### Task 8: Archive cards (models + SVG + copy)

**Files:**
- Create: `src/render/archive.ts`
- Modify: `src/render/cards.ts` (export `frame`, `C`, `TONE`, `plain`, `statsRow` for reuse), `src/i18n/{uk,ru,en}.ts` (new `archive` section)
- Test: `tests/archive-cards.test.ts` (new)

**Interfaces:**
- Consumes: `ArchiveDayStat`, `PeriodTotals`, `trend` (Task 7), `fmtDuration` style hours, `fitFont`.
- Produces:
  - `weekArchiveModel(days: ArchiveDayStat[], group: string | null, nowMs, cfg, t)`, `monthArchiveModel(days, monthIso, group, nowMs, cfg, t)`, `quarterArchiveModel(weeks: ArchiveDayStat[][], group, nowMs, cfg, t)` → models with `title`, `subtitle`, `stats: Stat[]`, rows/cells/columns, `footnote`, `caption`.
  - `svgArchiveWeek(m)`, `svgArchiveMonth(m)`, `svgArchiveQuarter(m)` → SVG string, width `CARD_W`.
  - Hours text `hrs(ms)`: `4.5 год`, `12 год` (one decimal, trailing `.0` dropped); bracket form `(4)`; emergency `⚠️ (6)`; nodata `немає даних`; planned 0 + actual → `— (2)`.
  - Copy keys under `t.archive` (uk): `weekTitle 'Графік · тиждень'`, `monthTitle(m) 'Графік · ${m}'`, `quarterTitle 'Графік · 3 місяці'`, `group(g) 'група ${g}'`, `withoutPower 'Без світла'`, `daysWith 'Днів з відкл.'`, `of(n, total) '${n} з ${total}'`, `longest 'Найдовше'`, `worstDay 'Найгірший'`, `worstWeek 'Найгірший тиждень'`, `trend 'Тренд'`, `perWeek 'годин без світла за тиждень'`, `footnote 'у дужках — скільки світла не було фактично'`, `emergency 'аварійні'`, `noData 'немає даних'`, `hours(n) '${n} год'`, `hoursShort(n) '${n}г'`; ru/en equivalents.
  - Layout follows `.superpowers/brainstorm/35763-1794100516/content/archive-final.html`: week rows with label column, 24 h bar (red planned, green rest, amber for emergency, `C.unknown` grey for nodata/future), right column for `planned (actual)`; month 7-column calendar, cell colour by planned hours (green 0 → red, amber emergency, grey nodata), cell text day / hours / (actual); quarter 13 columns height ∝ planned, white tick at actual, labels `dd.MM` under columns.
- [ ] **Step 1: Failing tests**: week model for a fixture week → row texts `['4.5 год (4)', '— (2)', '⚠️ (6)', 'немає даних', …]`, stats value `33.5 год (30)`; month model for October 2026 → 31 cells, first cell column = Thursday (index 3), emergency cell `kind 'emergency'`; quarter model → 13 columns, `trend` stat absent when `trend()` is null; every `svgArchive*` output parses as XML (`/<svg[\s\S]*<\/svg>$/`) and contains no `NaN`/`undefined`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Every right-column / cell / stat text uses `fitFont(text, boxW, base)`.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: week, month and 3-month schedule archive cards`.

### Task 9: Archive navigation in the bot

**Files:**
- Modify: `src/bot/keyboards.ts` (`scheduleKb`, new `archiveKb`), `src/bot/bot.ts` (callback `sa`, card builders), `src/i18n/{uk,ru,en}.ts` (`kb.archWeek/archMonth/archQuarter`, prev/next labels reuse `kb.prevWeek` etc. where they exist)
- Test: `tests/keyboards.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 6–8 (`repo.scheduleDaysBetween`, `repo.oldestScheduleDate`, `archiveStats`, models/SVG).
- Produces:
  - `scheduleKb(t)` → row 1 `[🔄 refresh, 🏠]`, row 2 `[Тиждень 'sa:w:now', Місяць 'sa:m:now', 3 місяці 'sa:q:now']`.
  - `archiveKb(kind: 'w'|'m'|'q', nav: PeriodNav, t)` → optional `‹ ›` row, then `[Тиждень, Місяць, 3 місяці, 🏠 'v:panel']`.
  - `resolveArchiveAnchor(kind, raw: string, oldestIso: string | null, todayIso: string, zone): string` — `now` → current period; anchors before the oldest stored day's period → oldest period; after today → current period. Nav `prev` null when the previous period ends before `oldestIso`, `next` null for the current period.
- [ ] **Step 1: Failing tests**: `scheduleKb` second row callback data `['sa:w:now','sa:m:now','sa:q:now']`; `archiveKb('w', {prev:'sa:w:2026-10-26', next:null}, uk)` first row has one button `‹ …`; **clamps out-of-range anchors**: `resolveArchiveAnchor('w','2025-01-06','2026-11-08','2026-11-08',z) === '2026-11-02'`, `('m','2027-01','2026-09-14','2026-11-08',z) === '2026-11'`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the `sa` branch next to `sch` in the callback handler: `showCard(ctx, (tt) => archiveCard(kind, anchor, tt))`; no address → same toast as `sch`.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: browse past schedules by week, month and 3 months`.

### Task 10: Text-fit check on every card, all languages

**Files:**
- Create: `scripts/preview-cards.ts` (+ npm script `preview`)
- Modify: whatever card code the previews show overlapping

**Interfaces:**
- Consumes: all models/SVG functions.

- [ ] **Step 1:** Write `scripts/preview-cards.ts`: renders to `tmp/preview/<card>-<lang>-<case>.png` for `uk`, `ru`, `en`: panel (grid on 9.87 kW red / grid on 0.06 kW / outage 8.49 kW red / outage unknown limits / stale / "не було 23 год 59 хв"), schedule card, week archive (all kinds incl. `— (12.5)`, `⚠️ (23.5)`, `немає даних`, a 25 h DST week), month archive (October 2026 and a 31-day month starting on Sunday — March 2026, with `23.5г (23.5)` cells), quarter archive (with and without trend, worst week 168 h), day/period/money/battery cards unchanged regressions, and notification captions.
- [ ] **Step 2:** `npm run preview`; open **every** PNG and check: no text crosses its box, tile, column or another text; numbers readable. Fix offenders with `fitFont` / shorter copy / wider columns; re-run until all are clean.
- [ ] **Step 3:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 4:** Commit `chore: card preview script; fix text fit`.

### Task 11: Release

- [ ] **Step 1:** `npm run readme-assets` (panel images change with the new scale/decimals); commit `docs: refresh README images`.
- [ ] **Step 2:** Owner's env: set `GRID_LOAD_MAX_KW=8` in the local `.env` and on the NAS `/volume1/docker/deye-bot/.env` (keep other lines untouched; `GRID_CHARGE_A`/`BATTERY_LOAD_MAX_KW` defaults are right).
- [ ] **Step 3: Local check first (owner's decision).** Owner stops the NAS bot (`sudo docker compose stop`); copy the NAS DB to a scratch dir (command in `CLAUDE.local.md`), run the new build locally against that copy with the real token, and check in Telegram: panel (grid on/off), settings, schedule + archive cards, a forced outage/return notification if possible. Then stop the local bot.
- [ ] **Step 4:** Only if the owner confirms the local check: copy to the NAS with the tar command from `CLAUDE.local.md`; owner runs `cd /volume1/docker/deye-bot && sudo docker compose up -d --build`.
- [ ] **Step 5:** After restart: `/status` shows no errors; panel shows `/ 10 kW` and `80 A ≈ 4.3x kW`; schedule card has the archive row; `sqlite3` on a fresh DB copy shows `schedule_days` with today and tomorrow.
