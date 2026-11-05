# Outage Schedule (YASNO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch the owner's YASNO outage schedule (group 52.1) every 20 min and use it in a panel tile, a `/schedule` image card, per-user reminders before planned off/on, and the "may not last" battery warning.

**Architecture:** `src/schedule/yasno.ts` is the only code that knows YASNO (HTTP, shapes, validation) and returns an internal `Schedule`. Pure functions in `src/schedule/logic.ts` turn `Schedule` + grid state + readings into what the tile/card/warnings/reminders show. `src/schedule/service.ts` is thin glue (timers, DB, admin notices). Render and bot layers consume the pure results.

**Tech Stack:** TypeScript ESM, Node 24 fetch, luxon, grammY, resvg, node:sqlite, vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-outage-schedule-design.md` (read the "Edge rules" section — it is binding).

## Global Constraints

- Tests: pure-function vitest only, in `tests/`; fixtures in `tests/fixtures/yasno/` are real responses from 2026-11-04 (group 52.1: today 10:00–20:00 and 22:00–24:00 `ScheduleApplies`; tomorrow `WaitingForSchedule`, no slots).
- No new dependencies. No git commits (owner commits). Short code comments, why not what.
- Every user-facing string lives in `src/i18n/{ru,uk,en}.ts` (`Dict = typeof ru`; uk/en must typecheck). Cards (`src/render/cards.ts`) stay text-free — labels come via models.
- YASNO: `BASE = https://app.yasno.ua/api/blackout-service/public/shutdowns`, region 25, DSO 902, 15 s timeout per request.
- Poll every 20 min; manual refresh ≤ 1/min (global); stale mark when `now − fetchedAt > 2 h`; grace 30 min (spec Edge rule 2); group re-resolve daily.
- Reminder options per user: off / 15 / 30 / 60 min, default 30 for both "before off" and "before on"; night mode silences them.
- The bot currently runs locally on the Mac (`NODE_USE_ENV_PROXY=0 npm start`, log `tmp/local-run.log`). Restart it after building to test; never run two instances.

## Review Focus

1. Times across DST days (25 h / 23 h): slot minute 1440 and 0 must map to the right absolute instants → test in Task 1 with a synthetic 2026-10-25 day.
2. Grid off after a 22–24 outage at 00:05 while today is still `waiting` → tile says "today not published", not "поза графіком" → test in Task 2.
3. A changed schedule moves an event: the reminder for the new time still fires once, the old one never fires → test in Task 3.
4. YASNO down for hours: tile/card keep the last schedule with a stale mark, no admin spam → test in Task 4 (`staleness`, `formatErrorNotice` once).
5. Address not configured (fresh install): no tile, `/schedule` says "адресу не задано", no crash → test in Task 6 (model returns `schedule: null`).

---

### Task 1: Internal model + YASNO adapter

**Files:** Create `src/schedule/model.ts`, `src/schedule/yasno.ts`; Test `tests/yasno.test.ts`.

**Interfaces — Produces:**
- `model.ts`: `type DayStatus = 'applies' | 'waiting' | 'emergency' | 'unknown'`; `interface Span { start: number; end: number }` (epoch ms, end exclusive); `interface ScheduleDay { date: string /* yyyy-mm-dd Kyiv */; status: DayStatus; outages: Span[] }`; `interface Schedule { group: string; days: ScheduleDay[] /* today, tomorrow */; updatedAt: number | null; fetchedAt: number; unknownTypes: string[] }`; `interface Address { streetId: number; street: string; houseId: number; house: string; group: string }`.
- `yasno.ts`: `class YasnoFormatError extends Error`; pure `parsePlanned(json: unknown, group: string, fetchedAt: number): Schedule` (throws `YasnoFormatError` on broken structure, including missing group key); `parseGroup(json: unknown): string` (→ `"52.1"`); `parseOptions(json: unknown): { id: number; name: string }[]` (streets/houses); `class YasnoClient { constructor(fetchFn?: typeof fetch); streets(q: string); houses(streetId: number, q: string); group(streetId: number, houseId: number): Promise<string>; planned(group: string): Promise<Schedule> }`.
- Mapping: `ScheduleApplies→applies`, `WaitingForSchedule→waiting`, `EmergencyShutdowns→emergency`, else `unknown`. Slot `Definite` → outage; `NotPlanned` → skip; any other type → outage + push to `unknownTypes` (deduped). Minutes are converted with luxon from the day's local date in `Europe/Kyiv` (`DateTime.fromISO(day.date).setZone(zone).startOf('day').plus({ minutes })`), so DST days come out right. Adjacent outage slots of one day are merged.

- [ ] **Step 1: Failing tests** (`tests/yasno.test.ts`):
  - fixture `planned-outages.json`, group `52.1` → `days[0]` = `{ date: '2026-11-04', status: 'applies', outages: [10:00–20:00, 22:00–24:00 Kyiv as ms] }`, `days[1]` = `{ date: '2026-11-05', status: 'waiting', outages: [] }`, `updatedAt === Date.parse('2026-11-04T18:15:01+00:00')`.
  - missing group `'99.9'` → throws `YasnoFormatError`; `parsePlanned(null, …)` and slots not an array → throw.
  - synthetic day `{ date: '2026-10-25T00:00:00+03:00', status: 'ScheduleApplies', slots: [{start:0,end:1440,type:'Definite'}] }` → one span exactly from local midnight to next local midnight, length 25 h.
  - slot type `'Possible'` → counted as outage, `unknownTypes` = `['Possible']`.
  - `parseGroup` on `group.json` → `'52.1'`; `parseOptions` on `streets.json` → `[{ id: 101, name: 'вул. Садова' }]`; houses fixture contains `{ id: 2002, name: '12/к2' }`.
  - `YasnoClient` with a fake fetch: `planned('52.1')` requests `…/regions/25/dsos/902/planned-outages`; `group(101, 2002)` sends `regionId=25&dsoId=902&streetId=101&houseId=2002`.
- [ ] **Step 2:** `npx vitest run tests/yasno.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `npm run typecheck` clean.

### Task 2: Schedule logic (pure)

**Files:** Create `src/schedule/logic.ts`; Test `tests/schedule-logic.test.ts`.

**Interfaces — Consumes:** Task 1 model. **Produces:**
- `GRACE_MS = 30 * 60_000`.
- `publishedOutages(s: Schedule): Span[]` — outages of `applies` days only, merged across midnight when contiguous.
- `type TileState =`
  - `{ kind: 'off-until'; until: number; endsAtDayEdge: boolean }` (grid off, covered; `endsAtDayEdge` = the merged span ends at the end of the last published day and the next day is not published),
  - `{ kind: 'off-late'; due: number }` (grid off, `now ≥ end + GRACE`),
  - `{ kind: 'off-unscheduled' }`, `{ kind: 'emergency' }`, `{ kind: 'today-unpublished' }`,
  - `{ kind: 'on-in-slot'; from: number; until: number }` (grid on inside a published span),
  - `{ kind: 'next'; start: number; end: number }` (grid on, next published span),
  - `{ kind: 'none-today'; preliminary: true }` (grid on, no more spans today and tomorrow not published or empty).
- `tileState(s: Schedule, grid: 'on' | 'off' | null, nowMs: number): TileState | null` — null when `grid === null`. Covered rule per spec Edge rule 2 (span contains now, starts within GRACE, or ended < GRACE ago). Today `emergency` → `emergency`; today `waiting`/`unknown` → `today-unpublished` (both grid states).
- `powerOnTarget(state: TileState | null): number | null` → `until` for `off-until`, else null.
- `batteryVerdict(soc: number, dischargeW: number, pvW: number, nowMs: number, targetMs: number, o: { capacityKwh: number; reservePct: number }): { ok: true } | { ok: false; endsAt: number; adviseLoadW: number }` — needed discharge = usable Wh / hours to target; `adviseLoadW = round10(needed + pvW)`. Reuse `runtimeHours` from `src/domain/forecast.ts`.
- `socAt(soc: number, chargeW: number, capacityKwh: number, fromMs: number, toMs: number): number` — capped at 100.

- [ ] **Step 1: Failing tests** — one per `TileState` kind using a hand-built `Schedule` (helper `sched(today: [h, h][], tomorrow: [h, h][] | 'waiting')`), including: merged `22–24` + `00–06` → `off-until` 06:00; grid off at 09:55 for a 10:00 span → `off-until` 20:00; off at 20:31 after a 20:00 end → `off-late`; on at 10:05 inside 10:00–20:00 → `on-in-slot`; today waiting at 00:05 with grid off → `today-unpublished` (Review Focus 2); `batteryVerdict(30, 1200, 0, 21:00, 06:00, {capacityKwh: 20, reservePct: 10})` → not ok, `adviseLoadW` = 20 kWh × 0.2 / 9 h = 444 → 440; with `pvW: 300` → 740; plenty of charge → ok. `socAt(80, 4000, 20, t, t + 1h) === 100`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, typecheck.

### Task 3: Reminders (pure)

**Files:** Modify `src/schedule/logic.ts`; Test `tests/schedule-logic.test.ts`.

**Interfaces — Produces:** `interface Reminder { kind: 'off' | 'on'; at: number /* event time */; key: string /* kind@at */ }`; `dueReminders(s: Schedule, grid: 'on' | 'off' | null, nowMs: number, leadMin: number, kind: 'off' | 'on', sent: Set<string>): Reminder[]` — events = starts (kind off) / ends (kind on) of `publishedOutages`; due when `at − lead ≤ now < at`; skipped if `sent` has the key, if `leadMin === 0`, or if the grid is already in the target state (off for 'off', on for 'on').

- [ ] **Step 1: Failing tests:** due exactly at lead; not before; not after the event; skipped when grid already off; schedule moved 21:00 → 21:30 after the 21:00 reminder was sent → the 21:30 one is due (Review Focus 3); `leadMin 0` → none.
- [ ] **Step 2–4:** FAIL → implement → PASS.

### Task 4: Storage + ScheduleService

**Files:** Modify `src/storage/db.ts` (migration), `src/storage/repo.ts`; Create `src/schedule/service.ts`; Modify `src/main.ts`; Test `tests/schedule-logic.test.ts`.

**Interfaces — Produces:**
- Migration: `ALTER TABLE users ADD COLUMN remind_off_min INTEGER NOT NULL DEFAULT 30;` and `… remind_on_min …` (two entries). `UserRow.remindOffMin`, `UserRow.remindOnMin`; `Repo.setReminder(tgId, kind: 'off' | 'on', min: number)`.
- kv keys: `schedule:address` (`Address`), `schedule:last` (`Schedule`), `schedule:sent` (string[] of reminder keys, pruned to the last 2 days), `schedule:notices` (`{ format?: string; unknownTypes?: string[] }` — what the admin was already told).
- Pure in logic.ts: `isStale(s: Schedule, nowMs: number): boolean` (> 2 h); `refreshAllowed(lastManualMs: number | null, nowMs: number): boolean` (≥ 60 s).
- `class ScheduleService { constructor(repo, client: YasnoClient, notifyAdmin: (render: Render) => void); start(); stop(); get(): Schedule | null; address(): Address | null; setAddress(a: Address): Promise<void> /* saves + fetches */; refresh(manual: boolean): Promise<'ok' | 'limited' | 'failed'>; onTick: ((s: Schedule) => void) | null }` — polls every 20 min; daily `client.group()` re-check: on change saves the new group and notifies admin (`t.schedule.groupChanged(old, new)`); on `YasnoFormatError` for a missing group key first re-resolves the group (address may have moved) and retries once, otherwise notifies admin once per distinct message; new `unknownTypes` notified once; network errors → `log.warn` only.
- Minute timer in main (or inside the service): for each approved user and kind, `dueReminders` → send text via existing `send`-style per-user path (respect quiet hours via `broadcast`'s `quietHour`), record keys.

- [ ] **Step 1: Failing tests:** `isStale` at 2 h ± 1 s; `refreshAllowed` at 59/60 s.
- [ ] **Step 2–4:** FAIL → implement (pure parts + service glue) → PASS; typecheck. Migration check with a throwaway script on a copy of `data/deye.db` (users get `remind_off_min = 30`).

### Task 5: "May not last" uses the schedule

**Files:** Modify `src/domain/watch.ts`, `src/monitor.ts`, `src/bot/ops-format.ts`, dicts; Test `tests/watch.test.ts`, `tests/ops-format.test.ts`.

**Interfaces:** `WatchEvent` `night_short` gains `target: 'schedule' | 'morning'` and `adviseLoadW: number`; `WatchState.nightWarnFor` keeps the dedupe key, now `"sched@<ts>"` or the morning date; re-arm when the scheduled target moved ≥ 30 min later (key differs). Monitor gets `scheduleTarget: () => number | null` (= `powerOnTarget(tileState(...))`) and uses battery discharge (avg of last 15 min of `-batteryPowerW` while < 0) instead of house load (spec Edge rule 6). With a target → `batteryVerdict`; without → existing `nightShortfall`.

- [ ] **Step 1: Failing tests:** render for `target: 'schedule'` contains `Світло за графіком о 06:00`-style text in uk/ru/en and the advice `~440 Вт`; existing night tests keep passing.
- [ ] **Step 2–4:** FAIL → implement → PASS.

### Task 6: Panel tile

**Files:** Modify `src/render/models.ts` (`PanelModel.schedule: ScheduleTile | null`), `src/render/cards.ts` (draw tile under the load block), `src/bot/format.ts` (`PanelCtx.schedule: { state: TileState; stale: boolean; verdict?: …; socAtOutage?: number } | null` + one text line), `src/bot/bot.ts` (`panelCtx` fills it from the service), dicts; Test `tests/models.test.ts`.

**Interfaces:** `ScheduleTile = { title: string; tone: Tone; note: string | null; noteTone: Tone }` (title like "Світло о 06:00 · через 9 год 45 хв", note like "⚠️ Батарей вистачить до ≈ 03:10 · знизьте до ~440 Вт"). Mockup: `.superpowers/brainstorm/60404-1793812023/content/schedule-layout.html` (right column).

- [ ] **Step 1: Failing tests:** each `TileState` kind → expected uk title/note; `schedule: null` (no address) → `m.schedule === null` (Review Focus 5); stale → note gets the stale suffix.
- [ ] **Step 2–4:** FAIL → implement → PASS. Render a preview PNG for 3 states and check it with the Read tool.

### Task 7: `/schedule` card + menu

**Files:** Modify `src/render/models.ts` (`scheduleModel(s, state, cfg, t, nowMs)`), `src/render/cards.ts` (`svgSchedule`), `src/bot/bot.ts` (`/schedule`, callbacks `sch:show`, `sch:refresh`), `src/bot/keyboards.ts` (`panelKb` gets "🗓 Графік" when an address is set; `scheduleKb(t)` = 🔄 Оновити + 🏠), `setupCommands` (add `schedule`), dicts; Test `tests/models.test.ts`.

- [ ] **Step 1: Failing tests:** model for the fixture schedule at 2026-11-04 21:00, grid off → title `Графік · група 52.1`, two days, today spans text `10:00 – 20:00`, `22:00 – 24:00`, tomorrow line "графік ще не опубліковано", status line for `off-until`; bars as fractions of the local day (DST-safe like the day card).
- [ ] **Step 2–4:** FAIL → implement → PASS. Refresh: `refreshAllowed` → toast `t.schedule.refreshed` / `t.schedule.tooOften`. Card shows the stale mark when `isStale`; `/schedule` without an address answers `t.schedule.noAddress`.

### Task 8: Owner address flow

**Files:** Modify `src/bot/settings-ui.ts` (home view line "🏠 Адреса: … · група 52.1" + button), `src/bot/bot.ts` (pending text input kinds `street` / `house`; callbacks `adr:st:<id>`, `adr:h:<id>`), dicts.

- [ ] **Step 1:** Implement (glue; no unit test by policy). Flow: tap "🏠 Адреса" → "Напиши назву вулиці" → reply → up to 10 buttons from `client.streets` (or "нічого не знайдено") → pick → "Напиши номер будинку" → buttons from `client.houses` → pick → `service.setAddress` → "✅ Адреса збережена · група 52.1".
- [ ] **Step 2:** Typecheck, build.

### Task 9: Personal reminder settings + sending

**Files:** Modify `src/bot/keyboards.ts` (`settingsKb` two cycle buttons "⚡ Перед відключенням: 30 хв" / "💡 Перед включенням: 30 хв", callback `set:rem:off` / `set:rem:on` cycling 0→15→30→60→0), `src/bot/bot.ts`, `src/main.ts` (minute timer → `dueReminders` per user), dicts; Test `tests/i18n-texts.test.ts`.

- [ ] **Step 1: Failing tests:** reminder texts in uk/ru/en (`t.schedule.remindOff('22:00', 30)` → "⚡ Відключення за графіком о 22:00 (через 30 хв)").
- [ ] **Step 2–4:** FAIL → implement → PASS; full suite, typecheck, build.

### Task 10: Previews, live test, deploy

- [ ] **Step 1:** Previews (uk/ru/en) of the schedule card and the tile states → `tmp/preview/`; add to `index.html`; check with Read; show the owner.
- [ ] **Step 2:** Rebuild, restart the local bot; set the address via the owner menu; check tile, `/schedule`, refresh, reminder settings; confirm logs clean.
- [ ] **Step 3:** Final whole-change review (fresh reviewer, most capable model) incl. Review Focus.
- [ ] **Step 4: Deploy (with the earlier, still undeployed grid-load/i18n/audit changes), after the owner's OK:**
  - stop the local bot; checkpoint `data/deye.db` (`PRAGMA wal_checkpoint(TRUNCATE)`);
  - owner deploys the worker: `cd worker && npx wrangler deploy`;
  - copy the NAS `.env`: update `DEYE_APP_SECRET` (rotated) and add `GRID_LOAD_MAX_KW=7` — write in place, never print values;
  - on the NAS delete stale `data/deye.db-wal` and `data/deye.db-shm`, then write `data/deye.db` in place (`cat > file`, keeps permissions so uid 1000 can write);
  - tar the code (README command); owner runs `cd /volume1/docker/deye-bot && sudo docker compose up -d --build`;
  - verify the startup message, `/status`, panel tile, `/schedule`.
