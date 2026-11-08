# Power limits, kW precision, outage notifications as panels, schedule archive

Date: 2026-11-08. Status: approved by the owner in chat.

## Why

The panel's load bar uses the wrong limits for this installation, so the numbers don't match what the inverter
really does (it says "charge limit 150 A ≈ 8.0 kW" while the batteries charge at ~4.2 kW; it says "9.6 kW" for an
outage while the inverter gives ~8.5 kW). The owner also wants finer kW values, outage notifications that behave
like the normal panel (with its buttons), and to see past YASNO schedules, which YASNO itself doesn't keep.

## Facts measured on this installation (2026-11-08)

- Inverter settings: Max A Charge 150 A, Max A Discharge 180 A, battery 460 Ah. Batt set2: **Grid Charge 80 A**
  (start 30 %), Gen Charge 40 A (unused, no generator). Deye Cloud returns `maxChargeCurrent` (150) and
  `maxDischargeCurrent` (180) from `/config/battery`; the Grid Charge current is **not** available in any endpoint
  (`/config/battery`, `/config/system`, `/config/tou`, `/device/latest` were checked).
- Bot readings, 4 days: grid charging always tops out at ~76.7 A ≈ 4.2 kW (SOC 90–99 %, 54–55 V). Max discharge
  seen: 3.2 kW (the 180 A limit was never reached). Max grid draw: 8.43 kW (house 4.07 + charge 4.15).
- Rated power reported by the inverter: 10 000 W.

## Part 1 — limits, precision, notifications, startup error

### 1.1 Grid-on load bar (`gridBlock`, `domain/load.ts`)
- Full scale **10 kW** (was `BREAKER_W` = 8 kW). Use the inverter's `ratedPowerW` when reported, else 10 kW.
  The "breaker" wording disappears from the grid-high alert note; the note shows the threshold and the 10 kW scale.
- Warning threshold `gridLoadMaxKw`: default **8**, options **7, 7.5, 8, 8.5, 9, 9.5**. Hysteresis stays 0.5 kW.
  `.env.example`/README default becomes 8. A DB override equal to an option no longer offered (5, 6, 6.5) is
  migrated: the owner's stored 7 is set to **8** once, on upgrade.
- Zones: yellow from 5 kW, orange from 6.5 kW, red from the threshold (each capped at the threshold). *(builder's
  call, agreed in chat)*
- Legend: `grid charge limit 80 A ≈ 4.38 kW` = configured grid-charge current × current battery voltage
  (nominal 51.2 V when unknown). 150 A from the cloud is no longer shown on the grid-on bar.
- New owner setting in ⚙️ (section `load`): **Grid charge current, A** — options 40, 50, 60, 70, 80, 90, 100, 120,
  150; default 80 (env `GRID_CHARGE_A`, default 80). Hint text says it must match Batt set2 → Grid Charge on the
  inverter, because the cloud doesn't report it.

### 1.2 Battery (outage) load bar (`batteryBlock`)
- Full scale = `min(rated, dischargeA × batteryV × 0.89)`; rated falls back to 10 kW. 0.89 ≈ voltage sag under
  full current (~3 %) × inverter efficiency (~94 %). With 180 A: ≈ 8.5 kW at 53 V, ≈ 8.0 kW at 50 V. If the
  discharge current is unknown, the scale is the rated power. *(builder's call, agreed in chat)*
- Legend: `discharge limit 180 A ≈ 8.5 kW · inverter 10 kW` (the kW is the derated figure above).
- New threshold `batteryLoadMaxKw` in ⚙️ (section `load`): options **6, 6.5, 7, 7.5, 8**, default **7**
  (env `BATTERY_LOAD_MAX_KW`). Red zone starts here; yellow from 50 % of the scale, orange from 70 % (both capped
  at the threshold).
- **Alert**: when the house draw on batteries (`upsLoadPowerW ?? loadPowerW`, grid off) reaches the threshold,
  **all users** get `⚠️ From batteries X.XX kW` + note (threshold, scale). All-clear 0.5 kW lower, silent. When the
  grid returns the state resets silently (mirror of `gridWatchStep`, which resets on outage). State lives in
  `WatchState` next to `gridHigh` (persisted in kv `watch`), so restarts don't re-alert.

### 1.3 kW with two decimals
- Every power shown in kW uses two decimals: panel tiles (`fmtPower`), load bar value/max/legends, flow, alerts
  (`ops-format`), schedule-tile advice, notifications text. Values under 1 kW stay in W with no decimals.
- Energy (kWh) and battery voltage keep their current precision.
- Bar max label: `/ 10.00 kW` → shown as `/ 10 kW` when it's a whole number, otherwise two decimals (`/ 8.47 kW`).

### 1.4 Outage notifications = the normal panel
- For `outage_started` and `outage_ended` the broadcast message is **exactly the panel card** a user gets from
  /start: same picture, same caption, same keyboard (`panelKb`, incl. 🗓 when an address is set).
- The quoted text block (`Будинок перейшов на батареї…`, `Не було…`) is no longer sent for these two events.
- Caption: the normal panel caption. While the last outage ended less than **1 hour** ago, the panel caption
  (every panel, not only the notification) is extended with its length: `🟢 Світло є · не було 3 год 52 хв`
  (all three languages). Computed in `panelModel` from the last closed outage, so live refreshes keep it.
  *(builder's call)*
- Each delivered message becomes that chat's live panel (`track(...)`), so it auto-refreshes like a /start panel;
  the previously live panel in that chat stops updating (one live panel per chat, as today).
- Text fallback (photo failed): the old text with the panel keyboard.
- Other loud events (battery low, night may not last) keep their current text + photo, now also with the panel
  keyboard. Schedule reminders stay plain text (no photo) and get the panel keyboard. *(builder's call)* They are **not** tracked as live (their caption is an event, not a status). Silent and
  admin/technical messages stay as they are (no photo, no keyboard).

### 1.5 Startup network error
- A poll failure whose error is DNS/network (`EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`, `fetch failed`) within the
  first 2 minutes after start is logged as `warn` and not counted in `/status` errors or sent to the admin.
  Later ones behave as today.

## Part 2 — YASNO schedule archive

### 2.1 Storage
- New table `schedule_days (date TEXT PRIMARY KEY, json TEXT NOT NULL)` (new migration). JSON:
  `{ group, status, outages: Span[], updatedAt, fetchedAt }`.
- On every successful fetch, each day in the response is upserted (latest wins, so the archive keeps a day's final
  version). The day already in kv `schedule:last` is written on first start after the upgrade.
- Status ranking on upsert *(owner-approved)*: `waiting` and `unknown` never overwrite a stored `applies` or
  `emergency` day. When a day turns `emergency`, the record keeps the last planned outages it had
  (`plannedOutages`) next to the new status.
- Retention: deleted together with readings (`RETENTION_MS`, 90 days) in `Poller.purge`.
- If the owner changes the address, older days keep their old group (the card shows the group of the current
  period's last day).

### 2.2 Fact
- "Actual" hours per day = time without power from the bot's own `outages` table (clipped to the day, ongoing
  outage clipped to now), via the existing `buildTimeline`/`summarize` from `domain/stats.ts`.

### 2.3 Cards (approved mockups: `.superpowers/brainstorm/*/content/archive-final.html`)
Navigation: the current schedule card's keyboard gets a second row **Тиждень · Місяць · 3 місяці**. Each archive
card has `‹ ›` (previous/next period; `›` hidden for the current period, `‹` hidden when there's no older data)
and `Тиждень · Місяць · 3 місяці · 🏠`. Callback data is language-independent, e.g. `sa:w:2026-11-02`,
`sa:m:2026-10`, `sa:q:2026-11-08`.

- **Week (Mon–Sun)**: title `Графік · тиждень`, subtitle `2 – 8 листопада · група 52.1`. Stats: without power
  `33.5 год (30)`, days with outages `5 з 7`, longest planned outage. 7 rows: day label, 24 h bar of planned
  outages, right column `4.5 год (4)`; planned 0 but real outage → `— (2)`; nothing at all → `—`. Axis 00…24.
  Footnote: `у дужках — скільки світла не було фактично`.
- **Month (calendar month)**: calendar grid Mon–Sun; cell colour by planned hours (green 0 → deeper red);
  cell shows day, planned hours, `(actual)`. Stats: total `140 год (128)`, days with outages `21 з 31`, worst day.
- **3 months (last 13 weeks)** *(changed by the owner after the live test)*: a grid — one row per Mon–Sun week, one
  cell per day coloured like the month calendar (green 0 → deeper red, amber emergency, grey no data); right column
  `144 (168)` = planned hours of the week and actual. Stats: total `1873 год (2184)`, days with outages, trend = last
  4 weeks vs the 4 before (worst week instead while fewer than 8 known weeks). Legend less → more + emergency.
- Everything in brackets (actual hours) is grey everywhere — week rows, stats, month cells, the 3-month grid.
- Archive period buttons have no icons so three fit in a row; every screen but the panel ends with `🏠 На головну`.
- **Emergency days** *(owner-approved)*: amber colour, label `⚠️ аварійні` (in the week row instead of the
  planned hours, e.g. `⚠️ (6)`; in the month cell `⚠️` + `(actual)`; in the 3-month column an amber part).
  They count in the actual totals, not in the planned ones. `waiting`/`unknown` days with nothing better stored
  render like "no data".
- "Days with outages" and "worst day/week" count **planned** hours (as in the approved mockup).
- Days with no archived schedule (before the archive started, or YASNO gave nothing) are grey, labelled
  `немає даних`, and excluded from totals. Future days in the current week: tomorrow from the schedule, the rest
  empty.

## Cross-cutting: text must never overlap

Every variable string on every card (old and new) must stay inside its box in **uk, ru and en** with long data:
`10.00 kW`, `9.5 kW`, `— (12.5)`, `23.5 год (23.5)`, longest month names, 31-day months starting on Sunday,
`немає даних`, long legends like `discharge limit 180 A ≈ 8.47 kW · inverter 10 kW`.
- Use `fitFont` (or explicit truncation for one-line legends) for every variable text; never rely on luck.
- Verification: a preview script renders every card × 3 languages × edge data to PNG; the builder inspects every
  image and fixes any overlap before claiming done. Unit tests cover `fitFont` limits for the new strings.

## Non-goals
- A second admin (postponed by the owner).
- Reading the Grid Charge current from the inverter automatically (not available in the cloud API).
- Backfilling schedules from before the archive started.

## Constraints
- No new runtime dependencies. TypeScript, grammY, resvg, node:sqlite as today.
- Callback data stays language-independent; old messages' buttons keep working.
- No personal data in the repo; commits without Claude attribution (owner's rule).
- Deploy: tar over ssh to the NAS; the owner runs `sudo docker compose up -d --build`.

## Added during the live test (owner-approved)

- **Schedule tile, power back early:** inside a scheduled slot, if the power went off and came back within it, the
  tile says `🟢 Світло дали раніше графіка` (green) with `за графіком відключення до 05:30, можуть вимкнути знову`
  (amber). Not off yet inside the slot: `Відключення за графіком вже йде з 00:00` · `світло поки є · до 05:30`.
- **Battery ring colour:** seven equal 15 % steps — 0 `#b91c1c`, 15 `#ef4444`, 30 `#f97316`, 45 `#facc15`,
  60 `#a3e635`, 75 `#4ade80`, 90–100 `#10b981`.
- **Load bar (variant B):** bar 18 px with rounded ends; home `#38bdf8`, charging `#e879f9`; legend values in the
  segment colour; the zone strip under it has rounded ends; the limit text moved to its own line under a thin
  divider with a ⚡ icon.
- **YASNO renumbered addresses:** when the group check gets HTTP 404, the bot looks the stored street and house up again
  by name (exact, case/spaces ignored) and saves the new ids; only if that fails does it tell the owner once to pick
  the address again.
- **Address search:** 10 results per page with `‹ Назад` / `Далі ›`, plus `1–10 з 34 — гортай або уточни номер`.

## Follow-up (2026-11-08 evening, owner-approved)

- **Load bar split:** "Home" is the inverter's measured house load (UPS-Load, same as the Home tile); "Batteries" is
  the rest of the grid draw, i.e. charging incl. ~4.5 % conversion losses. Fallback without UPS-Load: grid − DC battery.
- **Grid on, batteries idle** (|battery| < 100 W): top block reads `Будинок живиться від мережі · 1.42 кВт` and
  `Батареї повні · при 1.42 кВт вистачить на ≈ 14 год` (or `Батареї 36% · при …` below 99 %). Charging and real
  discharge keep `Заряд` / `Розряд`.
- **"Lasts about" colour by hours left** (idle and outage alike), 10 steps starting at the ring's 100 % colour:
  48+ `#10b981`, 36 `#2dcb80`, 24 `#4ade80`, 12 `#76e25a`, 9 `#a3e635`, 6 `#ced925`, 4 `#facc15`, 2 `#f97316`,
  1 `#ef4444`, below 1 h `#b91c1c`.
- **Long runtimes in days:** below 10 h `9 год 30 хв`, 10–48 h whole hours `14 год`, from 48 h days + hours
  `3 доб 12 год`, a week or more `> 7 доб` (no `≈` in front). Applies to the panel, notifications and text panel.
