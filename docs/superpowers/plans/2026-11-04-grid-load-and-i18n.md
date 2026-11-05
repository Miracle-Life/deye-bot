# Grid Load Block + Three Languages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show grid draw (house + batteries split, colored zones, charge limit) on the panel with an admin alert at ≥ 7 kW, then make the whole bot — texts, keyboards, images, watchdog — speak Ukrainian, Russian or English per user.

**Architecture:** Grid load is a pure domain module (`src/domain/load.ts`) feeding the panel model and a new watch event, plus a cached `/config/battery` read for the charge limit. i18n is a typed dictionary per language (`src/i18n/`), passed as `t: Dict` into every render function; senders render once per language and send each user their own version. The Cloudflare worker gets its own tiny dictionary and a `lang` per chat in the heartbeat.

**Tech Stack:** TypeScript (ESM), grammY 1.46, luxon 3.7, resvg-js 2.6, node:sqlite, vitest 5, Cloudflare Worker.

**Spec:** `docs/superpowers/specs/2026-11-04-grid-load-and-i18n-design.md`

## Global Constraints

- Tests: pure-function vitest only, in `tests/`. Don't add tests for I/O/Telegram glue. Verify the rest via `npm run typecheck`, `npm test`, `npm run build` and rendered previews.
- No new npm dependencies expected; if one is unavoidable, pin the exact version (`npm i pkg@x.y.z --save-exact`).
- **Never `git commit`/branch/push** — the project is not a git repo and the owner commits. "Checkpoint" steps below mean: run the checks, don't commit.
- Code comments: short, only where needed, explain why.
- The NAS bot keeps running until the owner stops it in Task 11. Never start the bot locally (`npm start`) before that — same Telegram token.
- Local runs need `NODE_USE_ENV_PROXY=0` (work-laptop proxy).
- Zones: green < 4 kW, yellow 4–5.5, orange 5.5–threshold, red ≥ threshold (default 7 kW). Bar scale 0–8 kW (breaker).
- Alert: admin only; fires at ≥ threshold, clears below threshold − 0.5 kW; once per episode.
- Languages: `uk | ru | en`. Existing users → `ru`. New users → from Telegram `language_code`: `uk*` → uk, `ru*` → ru, else en. 24-hour time everywhere.
- Panel is the same card for everyone (no admin/family split).

## Review Focus

1. Long Ukrainian/English strings overflowing pills, tiles, legend and stat labels on the PNG cards (widths are estimated by `textW`) → previews in all three languages with worst-case values (Task 11).
2. Ukrainian letters `і ї є ґ ’` rendering in the bundled Inter font through resvg → preview contains them (Task 11).
3. Grid power negative (export) or null → no block and no alert (test in Task 1).
4. Old worker receiving the new beat, or new worker receiving an old beat (no `lang`, or an unknown `lang`) → still works, falls back to `ru` (test in Task 10).
5. People without a DB row yet, or with an unknown `language_code` (access-request flow, "no access" replies) → get the picked language, never a crash (test in Task 6).

---

## Part 1 — Grid load

### Task 1: Grid-load domain logic

**Files:**
- Create: `src/domain/load.ts`
- Test: `tests/load.test.ts`

**Interfaces:**
- Produces:
  - `export const BREAKER_W = 8000; export const LOAD_HYSTERESIS_W = 500; export const MIN_SHOWN_W = 50;`
  - `export interface GridLoad { totalW: number; homeW: number; batteryW: number }`
  - `export function gridLoad(r: Pick<Reading, 'gridPowerW' | 'batteryPowerW'>): GridLoad | null` — null when `gridPowerW` is null or < `MIN_SHOWN_W`. `batteryW = min(max(batteryPowerW ?? 0, 0), totalW)`, `homeW = totalW − batteryW`.
  - `export type LoadZone = 'green' | 'yellow' | 'orange' | 'red'`
  - `export function loadZone(w: number, redFromW: number): LoadZone` — red if `w >= redFromW`, else orange if `≥ 5500`, else yellow if `≥ 4000`, else green.
  - `export function stepGridLoad(high: boolean, totalW: number, thresholdW: number): { high: boolean; event: 'high' | 'ok' | null }`

- [ ] **Step 1: Verify the sign of `TotalGridPower`.** Grid is on now; write a throwaway `tmp/grid-sign.ts` (model it on `tmp/latest-check.ts`) that prints `gridPowerW`, `loadPowerW`, `batteryPowerW` from `OfficialDeyeSource.latest()`. Run `NODE_USE_ENV_PROXY=0 npx tsx tmp/grid-sign.ts`. Expected: with no sun and the house consuming, `gridPowerW` > 0. If it is negative, negate it in `mapOfficialLatest` (`src/deye/official.ts`) so `Reading.gridPowerW` is always "import positive", and add a one-line comment there.

- [ ] **Step 2: Write failing tests** in `tests/load.test.ts`:

```ts
expect(gridLoad({ gridPowerW: 7000, batteryPowerW: 4100 })).toEqual({ totalW: 7000, homeW: 2900, batteryW: 4100 });
expect(gridLoad({ gridPowerW: 3000, batteryPowerW: 4100 })).toEqual({ totalW: 3000, homeW: 0, batteryW: 3000 }); // sun covers part of the charge
expect(gridLoad({ gridPowerW: 2000, batteryPowerW: -500 })).toEqual({ totalW: 2000, homeW: 2000, batteryW: 0 });
expect(gridLoad({ gridPowerW: -300, batteryPowerW: 0 })).toBeNull(); // export
expect(gridLoad({ gridPowerW: 20, batteryPowerW: 0 })).toBeNull();
expect(gridLoad({ gridPowerW: null, batteryPowerW: 100 })).toBeNull();
expect([3999, 4000, 5499, 5500, 6999, 7000].map((w) => loadZone(w, 7000))).toEqual(['green', 'yellow', 'yellow', 'orange', 'orange', 'red']);
expect(loadZone(5200, 5000)).toBe('red');
expect(stepGridLoad(false, 7000, 7000)).toEqual({ high: true, event: 'high' });
expect(stepGridLoad(true, 6600, 7000)).toEqual({ high: true, event: null }); // inside hysteresis
expect(stepGridLoad(true, 6499, 7000)).toEqual({ high: false, event: 'ok' });
expect(stepGridLoad(false, 6900, 7000)).toEqual({ high: false, event: null });
```

- [ ] **Step 3:** `npx vitest run tests/load.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `src/domain/load.ts` per Interfaces.
- [ ] **Step 5:** `npx vitest run tests/load.test.ts` → PASS.
- [ ] **Step 6: Checkpoint:** `npm run typecheck` clean.

### Task 2: Charge limit from inverter config

**Files:**
- Modify: `src/deye/types.ts` (DataSource), `src/deye/official.ts`
- Create: `src/charge-limit.ts`
- Modify: `src/main.ts` (start/stop the service)
- Test: `tests/official-map.test.ts`

**Interfaces:**
- Produces:
  - `DataSource.chargeLimitA?(): Promise<number | null>` (optional method)
  - `export function mapBatteryConfig(json: unknown): number | null` in `official.ts` — returns `maxChargeCurrent` if it's a positive finite number, else null.
  - `OfficialDeyeSource.chargeLimitA()` → `mapBatteryConfig(await this.call('/config/battery', { deviceSn: await this.resolveDevice() }))`.
  - `export class ChargeLimit { constructor(src: DataSource); start(): void; stop(): void; get(): number | null }` — fetches on `start()` and every 6 h; keeps the last good value; failures → `log.warn` only (never `log.error`: that pages the admin).

- [ ] **Step 1: Failing tests** in `tests/official-map.test.ts`:

```ts
expect(mapBatteryConfig({ code: '1000000', success: true, maxChargeCurrent: 150, maxDischargeCurrent: 180 })).toBe(150);
expect(mapBatteryConfig({ success: true })).toBeNull();
expect(mapBatteryConfig({ maxChargeCurrent: 0 })).toBeNull();
expect(mapBatteryConfig(null)).toBeNull();
```

- [ ] **Step 2:** `npx vitest run tests/official-map.test.ts` → FAIL.
- [ ] **Step 3:** Implement `mapBatteryConfig`, `chargeLimitA`, `ChargeLimit`; in `main.ts` create `const chargeLimit = new ChargeLimit(src)`, `start()` next to `heartbeat.start()`, `stop()` in `stop`.
- [ ] **Step 4:** Tests PASS; `npm run typecheck` clean.
- [ ] **Step 5: Live check:** throwaway `tmp/charge-limit.ts` calling `new OfficialDeyeSource(cfg).chargeLimitA()` → prints `150`.

### Task 3: Threshold setting

**Files:**
- Modify: `src/config.ts`, `src/settings.ts`, `.env` (add `GRID_LOAD_MAX_KW=7` — non-secret, OK in tracked files), `compose.yaml` only if it lists env vars explicitly
- Test: `tests/config.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Produces: `Config.gridLoadMaxKw: number` (env `GRID_LOAD_MAX_KW`, default 7); `Tunable` gains `'gridLoadMaxKw'`; new section `{ id: 'load', title: '⚡ Нагрузка из сети' }`; field `{ key: 'gridLoadMaxKw', section: 'load', label: 'Предупреждать от', kind: 'choice', options: [5, 6, 6.5, 7, 7.5], unit: 'кВт', hint: 'уведомление только владельцу; отбой — на 0.5 кВт ниже' }`. (Russian text here; Task 7 moves it into the dictionary.)

- [ ] **Step 1: Failing tests:** `loadConfig({...required, GRID_LOAD_MAX_KW: '6.5'}).gridLoadMaxKw === 6.5`, default `7`; `validValue('gridLoadMaxKw', 6.5) === true`, `validValue('gridLoadMaxKw', 8) === false`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, typecheck clean.

### Task 4: Panel block + text fallback

**Files:**
- Modify: `src/bot/format.ts` (`PanelCtx`, `renderPanel`), `src/render/models.ts` (`PanelModel`, `panelModel`), `src/render/cards.ts` (`svgPanel`, palette), `src/bot/bot.ts` (`panelCtx()` fills the new field; `BotOps` gains `chargeLimitA: () => number | null`), `src/main.ts` (pass `chargeLimitA: () => chargeLimit.get()`)
- Test: `tests/models.test.ts`, `tests/format.test.ts`

**Interfaces:**
- Consumes: `gridLoad`, `loadZone`, `BREAKER_W` (Task 1); `Config.gridLoadMaxKw` (Task 3).
- Produces:
  - `PanelCtx.chargeLimitA: number | null`
  - `PanelModel.load: { value: string; max: string; zone: LoadZone; homeFrac: number; batteryFrac: number; legend: { home: string; battery: string; limit: string | null } } | null` — fractions of `BREAKER_W`, clamped so `homeFrac + batteryFrac ≤ 1`; `null` when grid state is `'off'` or `gridLoad()` is null.
  - Values: `value = (totalW/1000).toFixed(1)`, `max = '8 кВт'`, legend `Дом 2.9`, `Батареи 4.1`, limit `лимит заряда 150 А ≈ 8.1 кВт` (at 54.3 V) where kW = `A × (r.batteryVoltage ?? 51.2) / 1000`, one decimal; `limit` null when `chargeLimitA` is null.
  - Text panel: one extra line after the battery block when load is shown: `⚡ Из сети <b>7.0 кВт</b> · дом 2.9 · батареи 4.1`.

- [ ] **Step 1: Failing tests** (`tests/models.test.ts`): reading `{ gridPowerW: 7000, batteryPowerW: 4100, batteryVoltage: 54.3 }`, grid `'on'`, `chargeLimitA: 150`, `gridLoadMaxKw: 7` → `load.value === '7.0'`, `load.zone === 'red'`, `load.homeFrac ≈ 0.3625`, `load.batteryFrac ≈ 0.5125`, `load.legend.limit === 'лимит заряда 150 А ≈ 8.1 кВт'`; same reading with grid `'off'` → `load === null`; `chargeLimitA: null` → `legend.limit === null`. In `tests/format.test.ts`: `renderPanel` contains `Из сети <b>7.0 кВт</b>`. Update existing `PanelCtx` fixtures with `chargeLimitA: null`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the model and the text line.
- [ ] **Step 4: Card.** In `svgPanel`, when `m.load` is set, insert a full-width block (height ≈ 92) between the ring area and the tiles, shifting tiles down; layout per mockup "A" (`.superpowers/brainstorm/*/content/grid-load-layout.html`): label row "⚡ Из сети" left, `7.0` (zone color, 26/700) + ` / 8 кВт` (muted) right; 10 px rounded bar (home = `C.blue`, batteries = `C.violet`); 4 px zone scale underneath (green 0–4, amber 4–5.5, orange 5.5–threshold, red threshold–8, widths from kW); legend row with two swatches left and limit right. Add `orange: '#fb923c'` / `orangeDeep: '#f97316'` to `C`. Zone → color: green `C.green`, yellow `C.amber`, orange `C.orange`, red `C.red`.
- [ ] **Step 5:** Tests PASS, typecheck clean. Render preview: adapt `tmp/cards-preview.ts` to write `tmp/panel-load.png` for the 7.0 kW case and a 3.2 kW green case; open both with the Read tool and check against the mockup.

### Task 5: Admin grid-load alert

**Files:**
- Modify: `src/domain/watch.ts` (`WatchState`, `initialWatch`, `WatchEvent`), `src/monitor.ts` (`onReading`), `src/bot/ops-format.ts` (`renderWatch`)
- Test: `tests/watch.test.ts`, `tests/ops-format.test.ts`

**Interfaces:**
- Consumes: `gridLoad`, `stepGridLoad` (Task 1).
- Produces: `WatchState.gridHigh: boolean` (initial false; old stored state without it merges to false); `WatchEvent` adds `{ type: 'grid_high'; load: GridLoad; limitW: number } | { type: 'grid_ok'; totalW: number }`.

- [ ] **Step 1: Failing tests** (`tests/ops-format.test.ts`): `renderWatch({ type: 'grid_high', load: { totalW: 7300, homeW: 3100, batteryW: 4200 }, limitW: 7000 }, z)` → `silent: false`, text contains `Из сети 7.3 кВт`, `дом 3.1 + батареи 4.2`, `Автомат ~8 кВт`; `grid_ok` with 6200 → `silent: true`, text contains `Нагрузка в норме · 6.2 кВт`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement texts: `<b>⚠️ Из сети 7.3 кВт</b>\n<i>дом 3.1 + батареи 4.2 · порог 7 кВт · автомат ~8 кВт</i>` (keep the asserted substrings; exact wording is the builder's, short) and `<b>✅ Нагрузка в норме · 6.2 кВт</b>`.
- [ ] **Step 4:** In `Monitor.onReading`, when `poller.state.grid !== 'off'` and `r.gridPowerW !== null`, take `totalW = max(r.gridPowerW, 0)` and call `stepGridLoad(this.watch.gridHigh, totalW, cfg.gridLoadMaxKw * 1000)`, store `gridHigh`, push the event to `'admin'` (`grid_high` carries `gridLoad(r)`). During an outage or with no grid data leave `gridHigh` unchanged.
- [ ] **Step 5:** Tests PASS, typecheck clean, `npm test` all green.

**End of Part 1 — show the owner `tmp/panel-load.png` (both cases) before starting Part 2.**

---

## Part 2 — Languages

### Task 6: i18n core, user language, language picker

**Files:**
- Create: `src/i18n/index.ts`, `src/i18n/ru.ts`, `src/i18n/uk.ts`, `src/i18n/en.ts`
- Modify: `src/storage/db.ts` (migration), `src/storage/repo.ts` (`UserRow.lang`, `upsertPendingUser`, `setLang`), `src/bot/keyboards.ts` (`settingsKb`), `src/bot/bot.ts` (`/start`, settings text, `set:lang:*` callback)
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Produces:
  - `export type Lang = 'uk' | 'ru' | 'en'; export const LANGS: Lang[] = ['uk', 'ru', 'en'];`
  - `export type Dict = typeof ru` (ru.ts is the source of truth: `export const ru = { locale: 'ru', … }`); `uk.ts`/`en.ts` export `const uk: Dict`, `const en: Dict` — a missing key fails typecheck. Parametrised strings are functions, e.g. `outageStarted: (when: string) => string`.
  - `export const dicts: Record<Lang, Dict>`; `export function pickLang(code: string | undefined): Lang`; `export function isLang(v: unknown): v is Lang`.
  - Dict always carries: `locale` (luxon locale: `'uk' | 'ru' | 'en'`), `units: { w, kw, kwh, v, a, min, h, d }`, `langName` (`'🇺🇦 Українська' | '🇷🇺 Русский' | '🇬🇧 English'`). Later tasks add their own keys to all three files.
  - Migration (append to `MIGRATIONS`): `ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'ru';` — existing users become `ru`.
  - `UserRow.lang: Lang` (unknown DB value → `ru`); `upsertPendingUser(u: { tgId; name; username; lang: Lang })` sets `lang` on INSERT only, never on conflict; `Repo.setLang(tgId: number, lang: Lang): void`.
  - Keyboard: `settingsKb(..., lang: Lang)` adds one row with three buttons, current one prefixed `● `, callback `set:lang:uk|ru|en`.

- [ ] **Step 1: Failing tests** (`tests/i18n.test.ts`):

```ts
expect(pickLang('uk')).toBe('uk'); expect(pickLang('uk-UA')).toBe('uk');
expect(pickLang('ru')).toBe('ru'); expect(pickLang('en-GB')).toBe('en');
expect(pickLang('de')).toBe('en'); expect(pickLang(undefined)).toBe('en'); expect(pickLang('')).toBe('en');
// runtime guard against empty strings slipping through `satisfies`
for (const l of LANGS) expect(leafStrings(dicts[l]).every((s) => s.trim().length > 0)).toBe(true);
```
(`leafStrings` is a small helper in the test that walks the dict and collects string leaves.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement core + migration + repo + picker. In `/start`, pass `lang: pickLang(ctx.from?.language_code)` to `upsertPendingUser`. On `set:lang:X`, `repo.setLang`, re-render the settings view in the new language, and refresh that chat's command menu (Task 8 provides `setupUserCommands`; until then, leave a call site stub that Task 8 fills — or do Task 8's command part here if simpler).
- [ ] **Step 4:** Tests PASS, typecheck clean. Unit-check the migration by opening a copy: `tmp/repo-check.ts`-style throwaway on `:memory:` → existing row reads `lang === 'ru'`.

### Task 7: Translate texts (format, ops-format, settings, keyboards)

**Files:**
- Modify: `src/bot/format.ts`, `src/bot/ops-format.ts`, `src/settings.ts`, `src/bot/settings-ui.ts`, `src/bot/keyboards.ts`, all three dicts
- Test: `tests/format.test.ts`, `tests/ops-format.test.ts`, `tests/settings.test.ts` (update call sites to pass `dicts.ru`; existing Russian assertions must keep passing unchanged), plus new English assertions

**Interfaces:**
- Produces (every exported formatter takes `t: Dict` as its **last** parameter):
  - `fmtDuration(ms, t)`, `fmtApprox(ms, t)`, `fmtPower(w, t)`, `renderEvent(e, cfg, t)`, `renderPanel(c, cfg, t)`, `renderDay(..., nowMs, dataFromTs, t)`, `renderWeek(..., cfg, t)`, `renderMonth(..., cfg, t)`, `renderAccessRequest(name, username, t)`.
  - `renderWatch(e, z, t)`, `renderCloud(e, z, t)`, `renderStartup(kind, downMs, z, nowMs, t)`, `renderError(key, t, repeats?)`, `renderStatus(s, z, t)`.
  - Settings: `Field` loses `label`, `hint`, `nullLabel`, `unit` text — the dict holds `settings.sections[sectionId]` and `settings.fields[key] = { label, hint?, nullLabel?, unit? }`; `fieldText(f, v, t)`; `homeView(s, t)`, `sectionView(s, id, t)`, `fieldView(s, f, t, note?)`.
  - Keyboards: every builder takes `t` last (`panelKb(t)`, `moneyKb(nav, t)`, `dayKb(dateIso, nav, zone, t)`, `periodKb(kind, anchor, nav, t)`, `accessKb(id, t)`, `usersKb(users, adminId, t)`, `settingsKb(…, lang, t)`, `restartKb(t)`). Callback data unchanged so old messages keep working.
  - Dates: replace every `.setLocale('ru')` with `.setLocale(t.locale)`.

- [ ] **Step 1: Failing tests (English):** `fmtDuration(8 * 60 * 60_000 + 12 * 60_000, dicts.en) === '8 h 12 min'`; `fmtDuration(26 * 3_600_000, dicts.uk) === '1 доба 2 год'` (builder may pick the Ukrainian abbreviation, then fix the assertion to it — but it must differ from Russian `сут`); `fmtPower(4100, dicts.en) === '4.1 kW'`; `renderEvent(outage_started fixture, cfg, dicts.en).text` contains `Power outage`; `renderWatch(grid_high fixture, z, dicts.uk).text` contains `З мережі 7.3 кВт`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Move every Russian literal in these files into `ru.ts` and translate into `uk.ts`/`en.ts` (natural, short; Ukrainian is not transliterated Russian). Russian output must stay byte-identical — the existing tests prove it.
- [ ] **Step 4:** `npm test` all green, typecheck clean, `grep -n '[А-Яа-яЁёІіЇїЄєҐґ]' src/bot/format.ts src/bot/ops-format.ts src/settings.ts src/bot/settings-ui.ts src/bot/keyboards.ts` → only comments.

### Task 8: Translate cards, bot handlers and command menus

**Files:**
- Modify: `src/render/models.ts`, `src/render/cards.ts`, `src/bot/bot.ts`, `src/deye/official.ts` / `src/deye/types.ts` / `src/poller.ts` (only if a Russian string reaches users — comments stay), dicts
- Test: `tests/models.test.ts`

**Interfaces:**
- Produces:
  - `panelModel(c, cfg, t)`, `dayModel(..., dataFromTs, t)`, `periodModel(title, rows, total, prev, cfg, t)`, `moneyModel(s, monthIso, tariff, days, nowMs, cfg, t)`; card SVG builders read the few fixed labels (`ОТКЛЮЧЕНИЯ`, `и ещё N`, `Траты на электричество из сети`, `Потрачено`, `Прогноз на месяц`, `ПО ДНЯМ`, `день`, `ночь`) from a `labels` field on their model (models fill it from `t`) — `cards.ts` stays dict-free.
  - In `bot.ts`: `const tOf = (id: number, code?: string): Dict => dicts[repo.getUser(id)?.lang ?? pickLang(code)]`; every handler resolves `t` once from `ctx.from`. All card functions take `t`.
  - `export async function setupCommands(bot: Bot, adminId: number, users: UserRow[]): Promise<void>` — default scope in English, plus `language_code: 'uk'` and `'ru'` variants; then per-chat scope for each approved user in their `lang` (admin gets the extra commands). `export async function setupUserCommands(bot: Bot, u: UserRow, isAdmin: boolean): Promise<void>` used after a language change.
  - Access-request message to the admin uses the **admin's** language; replies to the requester use `pickLang(ctx.from.language_code)`.

- [ ] **Step 1: Failing tests:** `panelModel(ctx, cfg, dicts.en).status.label === 'Power on'`, `.tiles[0].label === 'Home'`, `.load.max === '8 kW'`; `dayModel(..., dicts.uk).title` starts with an uppercase Ukrainian weekday (e.g. `Середа`); existing Russian model tests pass with `dicts.ru`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement.
- [ ] **Step 4:** `npm test` green, typecheck clean, the Cyrillic grep over `src/render src/bot src/main.ts` returns only comments and `ru.ts`/`uk.ts` are the only files with user-facing Cyrillic.

### Task 9: Per-language sending and live panels

**Files:**
- Modify: `src/monitor.ts` (`Send` type and every `sendSafe` call), `src/main.ts` (poller callback, `send`), `src/bot/bot.ts` (`panelPng`, `refreshLive`, `live` map)
- Test: `tests/notifier.test.ts` (only if `broadcast` changes — it shouldn't)

**Interfaces:**
- Produces:
  - `export type Render = (t: Dict) => Msg; export type Send = (render: Render, audience: Audience) => Promise<void>;`
  - `DeyeBot.panelPng(lang: Lang): Buffer | null`.
  - `send` in `main.ts`: pick recipients as today, group by `u.lang`, and for each language present: `msg = render(dicts[lang])`, photo `panelPng(lang)` for loud `'all'` messages, `broadcast(api, usersOfLang, …)`. Log one line per broadcast with totals.
  - `live` entries store `lang`; `refreshLive` renders at most one card per language per call (memoise inside the call).

- [ ] **Step 1:** Implement; Monitor passes closures, e.g. `this.sendSafe((t) => renderWatch(e, tz, t), who)`; the poller callback becomes `send?.((t) => renderEvent(e, cfg, t), 'all')`.
- [ ] **Step 2:** `npm test` green, typecheck clean, `npm run build` succeeds.

### Task 10: Watchdog worker in three languages

**Files:**
- Modify: `worker/src/logic.ts`, `worker/src/index.ts`, `src/heartbeat.ts`
- Test: `tests/watchdog.test.ts`, `tests/notifier.test.ts` (heartbeatPayload)

**Interfaces:**
- Produces:
  - Worker: `type Lang = 'uk' | 'ru' | 'en'` (own copy — separate build); `Chat.lang: Lang`; `parseBeat` maps missing/unknown `lang` → `'ru'`; `onCron(...)` and `onBeat(...)` return `{ state; msg: ((lang: Lang) => string) | null }`; `duration(ms, lang)` with `год/хв`, `ч/мин`, `h/min`.
  - `index.ts` `tell` sends `msg(c.lang)` per chat.
  - Bot: `Beat.chats[].lang: Lang`; `heartbeatPayload` copies `u.lang`.

- [ ] **Step 1: Failing tests:**

```ts
expect(parseBeat({ ...beatJson, chats: [{ id: 1, muted: false, nightQuiet: false }] })!.chats[0]!.lang).toBe('ru');
expect(parseBeat({ ...beatJson, chats: [{ id: 1, muted: false, nightQuiet: false, lang: 'de' }] })!.chats[0]!.lang).toBe('ru');
expect(parseBeat({ ...beatJson, chats: [{ id: 1, muted: false, nightQuiet: false, lang: 'en' }] })!.chats[0]!.lang).toBe('en');
const r = onCron(beat(T0), { downSince: null }, T0 + 11 * MIN, 10 * MIN);
expect(r.msg!('ru')).toContain('Дом не на связи с 10:20');
expect(r.msg!('en')).toContain('Home offline since 10:20');
expect(onBeat({ downSince: T0 }, T0 + 35 * MIN, 'Europe/Kyiv').msg!('uk')).toContain('35 хв');
expect(heartbeatPayload([{ ...users[0]!, watchdog: true, lang: 'uk' }], cfgLite, 5).chats[0]!.lang).toBe('uk');
```
Existing worker assertions switch from `r.msg` to `r.msg!('ru')`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` green; `cd worker && npx tsc --noEmit -p .` clean.

### Task 11: Previews, local live test, deploy

**Files:** throwaway scripts in `tmp/` only.

- [ ] **Step 1: Previews.** Extend `tmp/cards-preview.ts` to render, for each of `uk/ru/en`: panel (charging 7.0 kW red with limit; outage with 2 phases missing; stale data), day, week, month, money → `tmp/preview/<card>-<lang>.png`; and print `renderEvent`/`renderWatch` texts for every event type. Worst-case fixtures: 3-day outage duration, 4-digit voltages, a long Ukrainian weekday (`Понеділок`), and text containing `і ї є ґ ’`. Open every PNG with the Read tool; fix any overflow/clipping or missing glyphs (Review Focus 1–2). Then show the owner the panel + money PNGs in all three languages and wait for their OK on wording.
- [ ] **Step 2: Stop NAS bot** — ask the owner to run on the NAS: `cd /volume1/docker/deye-bot && sudo docker compose stop`. Copy the DB to the Mac: `ssh -p 22 admin@192.168.1.10 'cd /volume1/docker/deye-bot && tar cf - data' | tar xf - -C /tmp/claude-nas-db` (if permission denied, ask the owner to run it with sudo), then point a local `DB_PATH` at that copy (don't overwrite `./data` silently — back it up first).
- [ ] **Step 3: Local run:** `npm run build && NODE_USE_ENV_PROXY=0 npm start`. Owner checks in Telegram: panel shows the load block; `/settings` language switch changes texts, buttons and the command menu; statistics and money cards in all three languages; a temporary low threshold (e.g. 5 kW via `/settings`) triggers the admin alert and the clear. Restore the threshold to 7 afterwards.
- [ ] **Step 4: Deploy (only after the owner's OK):** stop the local bot (Ctrl+C). Owner deploys the worker first: `cd worker && npx wrangler deploy`. Copy the local DB back so data collected during the test isn't lost, then ship code via `tar` over ssh (exclude `node_modules`, `dist`, `data`, `.env`, `tmp`, `.superpowers`, `worker/node_modules`); add `GRID_LOAD_MAX_KW=7` to the NAS `.env`. Owner runs `sudo docker compose up -d --build`. Verify: the startup message arrives, `/status` is healthy, panel renders. Also confirm luxon month names in the container are localized (`docker compose logs` free of errors; a Ukrainian day card shows Ukrainian month).
