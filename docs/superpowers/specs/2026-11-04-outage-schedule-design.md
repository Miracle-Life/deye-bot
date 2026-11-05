# Deye bot: planned outage schedule (YASNO) — design

Date: 2026-11-04. Builds on the live bot (`2026-11-04-deye-telegram-bot-design.md`) and the grid-load/i18n change (`2026-11-04-grid-load-and-i18n-design.md`).

## Why

Kyiv has scheduled outages by group. During an outage the owner wants to know **when power comes back** and **whether the batteries will last until then** — across midnight (today until 24:00 + tomorrow 00:00–06:00 is one outage: "until 06:00"). Before outages they want a heads-up. The schedule changes often and today's may only appear at 6–8 am, so the bot must keep it fresh and be honest when it is preliminary or stale.

## Data source (verified live on 2026-11-04)

Unofficial public YASNO API, no key, plain GET (found in the `ha-yasno-outages` Home Assistant integration):

```
BASE = https://app.yasno.ua/api/blackout-service/public/shutdowns
GET BASE/addresses/v2/regions                                   → [{id:25, value:"Київ", dsos:[{id:902,...}]}, ...]
GET BASE/addresses/v2/streets?regionId=25&dsoId=902&query=…      → [{id:101, value:"вул. Садова"}]
GET BASE/addresses/v2/houses?regionId=25&dsoId=902&streetId=101&query=… → [{id:2002, value:"12/к2"}, ...] (max ~20 per query)
GET BASE/addresses/v2/group?regionId=25&dsoId=902&streetId=101&houseId=2002 → {"group":52,"subgroup":1}  → key "52.1"
GET BASE/regions/25/dsos/902/planned-outages                     → { "1.1": {...}, …, "60.1": {...} }
```

Per group: `{ today: Day, tomorrow: Day, updatedOn: ISO }`, `Day = { date: ISO with offset, status, slots: [{start, end, type}] }`. `start`/`end` are minutes from local midnight (0..1440). `type`: `Definite` = outage, `NotPlanned` = power. `status` seen: `ScheduleApplies`, `WaitingForSchedule`; third-party docs also mention `EmergencyShutdowns`. Unknown statuses/types must not break anything.

Owner's address: Kyiv (25/902), street 101, house 2002 ("12/к2"), group **52.1**. Validated: today's real outage started 10:07, schedule 52.1 says 10:00 (group 5.1 would say 11:00).

`probable-outages` (weekly "possible") currently returns all `NotPlanned` — **not used**.

Real responses are saved in `tests/fixtures/yasno/` (regions, streets, houses, group, planned-outages, probable-outages).

## Architecture (owner requirement: easy to fix when the API changes)

- **One adapter file** (e.g. `src/schedule/yasno.ts`) does all HTTP + parsing + validation and converts to an internal model. Nothing else knows YASNO's shapes, URLs, ids or type strings.
- **Internal model** (owner's words: simple): per day — date, status (`applies` | `waiting` | `emergency` | `unknown`), list of outage intervals `[startMs, endMs)` in absolute time (DST-safe: build from the local date + minutes in Europe/Kyiv); plus `updatedAt` (YASNO's `updatedOn`) and `fetchedAt` (ours).
- **Strict validation** in the adapter: an unexpected shape → typed error; the bot keeps the last good schedule, shows it as stale, and tells the admin once ("YASNO changed its response format", with the error) — not on every poll.
- Pure domain functions (tested) on top of the model; the service (timer, DB, Telegram) stays thin.

## Behaviour

### Polling
- Every **20 min** (my call within the owner's 20–30). First fetch on startup.
- Last good schedule persisted in the DB (kv) so it is shown immediately after a restart.
- Network/HTTP errors: keep last good, log warn; no admin spam.
- Stale: show "дані від HH:MM"; if older than **2 h** (my call) add "⚠️ можуть бути застарілими".

### Panel tile "🗓 За графіком" (shown to everyone; only when an address is configured)
Placed under the "From grid / From batteries" block. Owner approved the mockup (`.superpowers/brainstorm/*/content/schedule-layout.html`).

- **Power off (discharging):** "Світло о 06:00 · через 9 год 45 хв" — the end of the scheduled outage interval that covers now, **merged across midnight** with tomorrow's slots if contiguous.
  - Battery verdict vs that time: "✓ Батарей вистачить із запасом" or "⚠️ Батарей вистачить до ≈ 03:10 при 1.2 кВт" + advice "Щоб дотягнути до 06:00 — знизьте споживання до ~750 Вт" (needed W = usable Wh above reserve / hours left, rounded to 10 W, existing runtime/reserve logic).
  - If the merged interval ends at the end of the last published day (tomorrow not published): "до 24:00 · графік на завтра ще не опубліковано".
  - Outage not covered by the schedule (emergency, or off-schedule): "Відключення поза графіком" (and if status is emergency: "Екстрені відключення · графік зараз не діє").
- **Power on (charging or idle):** next scheduled outage today/tomorrow: "Відключення о 22:00 · через 1 год 15 хв · до 06:00" (end merged across midnight) + "до відключення батареї ≈ 100%" (SOC projected with current charge power, capped at 100; omitted if not charging).
  - No outages in the rest of today and none published for tomorrow: "Сьогодні без відключень" + "попередньо · графік може змінитися" (owner's wording intent).
- Emergency status for today → "Екстрені відключення" (red), "графік зараз не діє".
- Load used for the battery verdict: same as the existing night check (average of the last 15 min, fallback current load).

### Schedule screen `/schedule` (+ "🗓 Графік" button under the panel)
Image card (owner chose the image variant): title "Графік · група 52.1", "оновлено HH:MM" (YASNO `updatedOn`, plus stale mark as above), two 0–24 bars for today and tomorrow (red = outage, a "now" marker on today), outage times listed under each bar, total hours without power per day, status line (current state / "графік на завтра ще не опубліковано" / "попередньо без відключень" / emergency). Keyboard: "🔄 Оновити" (fetches YASNO immediately; global rate limit 1/min — otherwise shows the cached one with a toast) and "🏠". Caption carries the same times as text. Language per user.

### Notifications (per user, in personal `/settings`)
- "⚡ Відключення за графіком о 22:00 (через 30 хв)" and "💡 Світло за графіком о 06:00 (через 30 хв)".
- Each user sets each one: off / 15 / 30 / 60 min; **default 30 for both, on** (existing users get the defaults too).
- Skip if the grid is already in that state (off before a planned off; on before a planned on). Skip if the schedule is not published. Each event fires once (dedupe by event time; if the schedule moves the event, the new time can fire).
- Night mode applies (silent during quiet hours), like other notifications. Panel picture not attached (plain text).
- **No** notifications about schedule publication/changes — the card and tile update themselves (owner's decision).

### "May not last" warning (my call, owner did not object)
Generalize the existing "🌙 До утра може не хватити" (`src/domain/watch.ts`, fixed 07:00 target, evening only): during an outage the target becomes the **scheduled power-on time** when a schedule covers the outage; otherwise keep the current 07:00 night logic. Sent once per outage target; re-armed if the power-on time moves ≥ 30 min later. Text includes the advice "знизьте до ~N Вт". Audience unchanged (all).

### Edge rules (my calls, from the builder check)

1. **Grid state comes from the detector** (`poller.state.grid`), not from battery charge/discharge.
2. **Schedule vs reality never line up exactly.** Grace = **30 min**:
   - grid off and a scheduled outage interval contains now, or starts within the next 30 min, or ended less than 30 min ago → "covered": the tile shows that interval's (merged) end as the power-on time;
   - grid off, the scheduled power-on time has passed by ≥ 30 min → "Світло мало бути о 20:00 · затримується"; the "may not last" target falls back to the existing 07:00 night logic;
   - grid off, no interval within grace → "Відключення поза графіком" (or "Екстрені відключення" when today's status is emergency);
   - grid on inside a scheduled interval (slot started, power still there) → "Відключення за графіком з 10:00 · світло поки є" + its end time; the next interval is not shown until this one is over.
3. **Only `ScheduleApplies` days are "published".** Slots of `waiting` / `emergency` / `unknown` days are ignored (not shown, no notifications). Today `waiting` (typical 00:00–~08:00) → tile/card say "Графік на сьогодні ще не опубліковано"; if the grid is off then, the tile says that instead of "поза графіком".
4. **Unknown slot `type`** → treated as an outage (conservative: never hide a possible outage) and the admin gets one notice "YASNO: невідомий тип слоту X". Unknown day status → `unknown` (ignored, as above). Only a structurally broken response (not JSON, missing group key, slots not an array, bad numbers) counts as "format changed".
5. **Group re-check:** the bot re-resolves address → group once a day; if YASNO moved the address to another group it switches automatically and tells the admin ("Група змінилась: 52.1 → 47.1"). A group key missing from `planned-outages` triggers an immediate re-resolve before reporting a format error.
6. **Battery verdict uses battery discharge, not house load** (average of the last 15 min of `-batteryPowerW` while discharging; current value as fallback), so daytime solar is accounted for. At night this equals the house load, as before. The advice "знизьте споживання до ~N Вт" gives a house-load target: N = needed discharge + current PV, rounded to 10 W.

### Owner settings → "🏠 Адреса"
New section in the owner settings menu: "Адреса: вул. Садова, 12/к2 · група 52.1" → "Змінити": owner types a street → bot lists matches (buttons) → owner types a house number → bot lists matches → owner picks → bot fetches the group, shows it, saves {regionId, dsoId, streetId, streetName, houseId, houseName, group} in the DB. Region/DSO fixed to Kyiv 25/902 (my call; the only region the owner needs). Until an address is set: no tile, no `/schedule` button/command entry (command answers "адресу не задано").

## Non-goals
- Weekly/probable schedule; notifications about schedule changes; multiple addresses; regions other than Kyiv; scraping the DTEK site (Incapsula-protected).
- Changing how real outages are detected (still Deye data).

## Anti-goals
- Showing a wrong group/time silently when YASNO changes its format.
- Notification spam (repeat reminders, reminders when the state already happened).
- Hammering YASNO (polls 20 min; refresh ≤ 1/min).

## Constraints
- Same project rules as before: minimal pure-function vitest tests in `tests/`, exact npm pins if any dependency (none expected), no git commits by the agent, i18n for all texts (uk/ru/en, `Dict` must stay complete), cards stay text-free (labels via models), live testing on the Mac first (bot currently runs locally), then deploy.
- YASNO calls from the Mac/NAS must go direct (`NODE_USE_ENV_PROXY=0` locally).

## Left to the builder
- Exact card/tile layout metrics (follow `src/render/cards.ts` style), file split inside `src/schedule/`, DB storage keys, how the minute-level notification scheduler is driven (existing timers vs a new one), callback data names (must not collide with existing ones).
