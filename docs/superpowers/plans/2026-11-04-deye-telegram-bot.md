# Deye Home Telegram Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram-бот «Deye Home» на Synology NAS: уведомления о пропаже/возврате света, панель с данными инвертора, статистика по свету, общий доступ для семьи.

**Architecture:** Один Node-процесс в Docker. `Poller` раз в минуту берёт последний замер из `DataSource` (адаптер Deye Cloud), пишет его в SQLite и прогоняет через чистый `detector` (state machine), который выдаёт события; `Notifier` рассылает их одобренным пользователям. Бот (grammY) рисует панель/статистику из БД, редактируя одно сообщение. Вся логика (классификация сети, детектор, прогнозы, статистика, форматирование) — чистые функции.

**Tech Stack:** Node.js 24 LTS, TypeScript (strict, ESM), grammY, better-sqlite3, luxon (Europe/Kyiv, DST), vitest, Docker compose.

**Spec:** `docs/superpowers/specs/2026-11-04-deye-telegram-bot-design.md` (+ макеты в `docs/superpowers/mockups/`). Исполнитель читает spec и план вместе.

## Global Constraints

- Бот **только читает** Deye; никаких запросов на запись/управление инвертором.
- Источник данных — Deye Cloud: официальный OpenAPI (`https://eu1-developer.deyecloud.com/v1.0`), запасной — неофициальный API приложения; выбор через `DEYE_SOURCE=official|unofficial`.
- npm-зависимости — **точные версии** (`npm i pkg@x.y.z --save-exact`; актуальную версию брать `npm view pkg version`). Никаких `^`/`~`.
- Секреты только в `.env` (в `.gitignore`); в репо — `.env.example`. Секреты никогда не логировать (в т.ч. токены в URL).
- Интерфейс бота — на русском, тексты по макетам. Часовой пояс — `Europe/Kyiv`.
- Код, комментарии, сообщения коммитов — на английском; комментарии короткие, только «почему».
- Тесты: только vitest на чистые функции, в папке `tests/`. БД, Telegram и сеть тестами не покрываются — проверка через `npm run typecheck`, `npm run build` и ручные шаги.
- **Git: агент не коммитит, не создаёт веток и не пушит.** Шаг «Commit» = предложить пользователю текст коммита; коммитит он сам.
- Хранение: замеры, отключения, пропуски — не старше **90 дней**; чистка раз в сутки.
- Значения по умолчанию (из spec, настраиваются в `.env`): опрос `POLL_INTERVAL_SEC=60`, «нет данных» `STALE_AFTER_MIN=15`, резерв `BATTERY_RESERVE_PCT=10`, ёмкость `BATTERY_CAPACITY_KWH=24`, пороги `50,30,20,10`.
- Только личные чаты; апдейты из групп игнорируются.

## Review Focus

1. **Перезапуск контейнера во время отключения** → никаких повторных «🔴 Свет пропал», отключение продолжается с тем же началом (Task 5: тест `restores state without re-emitting outage_started`).
2. **Облако отдаёт тот же замер повторно** (timestamp не изменился) → не считается новым и не подтверждает «пограничное» состояние (Task 5: тест `ignores duplicate reading timestamp`).
3. **Истёк/отозван токен Deye, 401/ошибки сети** → одно обновление токена и повтор; при дальнейших сбоях — путь «нет данных», а не отключение (Task 2: тест `refreshes token once on 401`; Task 5: stale-тесты).
4. **Сутки перевода часов и отключение через полночь** → в сутках перевода часов (25.10.2026, 25 ч) сумма категорий = длине суток; отключение 22:00–02:00 делится 2 ч + 2 ч (Task 7: тесты `DST day sums to 25h`, `outage across midnight splits`).
5. **Пользователь заблокировал бота (403)** → рассылка остальным продолжается, пользователь помечается `blocked` (Task 9: тест `broadcast continues when one user blocked`).

---

## File Structure

```
deye-bot/
  package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example, .dockerignore
  Dockerfile, compose.yaml
  docs/deye-fields.md            # маппинг полей API → Reading (результат Task 1)
  scripts/discover.ts            # разведка API, печать сырых ответов (без секретов)
  src/
    main.ts                      # сборка и запуск всего
    config.ts                    # загрузка/валидация env → Config
    log.ts                       # логгер с редактированием секретов
    deye/types.ts                # Reading, DataSource
    deye/official.ts             # OfficialDeyeSource (+ токен)
    deye/unofficial.ts           # UnofficialDeyeSource (Task 3, условно)
    domain/grid.ts               # classifyGrid
    domain/forecast.ts           # runtimeHours, timeToFullMin
    domain/detector.ts           # state machine → DetectorEvent[]
    domain/stats.ts              # timeline, day/week/month агрегаты, полоска
    storage/db.ts                # открытие БД, миграции
    storage/repo.ts              # CRUD + purge
    bot/format.ts                # тексты панели/вкладок/уведомлений/статистики
    bot/keyboards.ts             # inline-клавиатуры, callback data
    bot/bot.ts                   # grammY: доступ, команды, callbacks
    bot/notifier.ts              # рассылка событий
    poller.ts                    # цикл опроса, backfill, тики stale, retention
  tests/ (grid, forecast, detector, stats, format, official-map, notifier, config)
```

---

### Task 1: Каркас проекта, конфиг и разведка Deye OpenAPI

Цель — выяснить, работает ли официальный доступ, и зафиксировать реальные поля. **Нужен пользователь**: создать приложение на developer.deyecloud.com (или выяснить, что «облачный ключ» в приложении = AppID/AppSecret) и самому вписать секреты в локальный `.env`.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (`node_modules`, `dist`, `.env`, `data/`), `.env.example`, `src/config.ts`, `src/log.ts`, `scripts/discover.ts`, `docs/deye-fields.md`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `interface Config { deyeSource: 'official'|'unofficial'; deyeBaseUrl: string; deyeAppId: string; deyeAppSecret: string; deyeEmail: string; deyePassword: string; deyeStationId: string|null; telegramToken: string; adminTelegramId: number; pollIntervalSec: number; staleAfterMin: number; batteryReservePct: number; batteryCapacityKwh: number; batteryThresholds: number[]; gridOffVolts: number; gridOkVolts: number; dbPath: string; timezone: string }`
  - `loadConfig(env: NodeJS.ProcessEnv): Config` — бросает `Error` со списком отсутствующих обязательных ключей.
  - `sha256Hex(s: string): string` (в `src/deye/official.ts`, lowercase hex — пароль для токена).
  - `log.info/warn/error(msg: string, extra?: object)` — маскирует значения ключей, содержащих `secret|password|token`.
- npm scripts: `build` (tsc), `typecheck` (tsc --noEmit), `test` (vitest run), `discover` (tsx scripts/discover.ts), `start` (node dist/main.js).

- [ ] **Step 1: Init project** — `npm init -y`, `"type": "module"`; deps (exact): `grammy better-sqlite3 luxon`; dev (exact): `typescript tsx vitest @types/node @types/better-sqlite3 @types/luxon`. tsconfig: `strict`, `module/moduleResolution: NodeNext`, `target ES2023`, `outDir dist`.
- [ ] **Step 2: Write failing tests** `tests/config.test.ts`:
  - `throws listing missing keys` — `loadConfig({})` бросает, сообщение содержит `TELEGRAM_TOKEN` и `ADMIN_TELEGRAM_ID`.
  - `applies spec defaults` — минимальный env → `pollIntervalSec 60, staleAfterMin 15, batteryReservePct 10, batteryCapacityKwh 24, batteryThresholds [50,30,20,10], gridOffVolts 50, gridOkVolts 180, timezone 'Europe/Kyiv', deyeSource 'official'`.
  - `sha256Hex matches known vector` — `sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'`.
- [ ] **Step 3: Run** `npx vitest run tests/config.test.ts` → FAIL (модули не существуют).
- [ ] **Step 4: Implement** `loadConfig`, `sha256Hex` (node:crypto), `log`. `.env.example` со всеми ключами Config (UPPER_SNAKE) и комментариями, без значений.
- [ ] **Step 5: Run** тесты → PASS; `npm run typecheck` → без ошибок.
- [ ] **Step 6: Write `scripts/discover.ts`** — получает токен (`POST {base}/account/token?appId=…`, body `{appSecret, email, password: sha256Hex(password)}`), затем печатает: список станций, устройства станции, «latest» станции и устройства инвертора (SN `2400000001`), и если есть — исторические данные за последние сутки. Перед печатью рекурсивно заменять значения ключей `token|secret|password|accessToken` на `***`. Эндпоинты брать из официальной документации портала; если документация недоступна — из открытых клиентов (deyecli, HA DeyeCloud).
- [ ] **Step 7: Run with user** — пользователь заполняет `.env`, запускает `npm run discover > /tmp/deye-raw.json`. Ожидание: станция «Home Deye» в списке, latest содержит SOC/мощности/напряжения сети. Сохранить урезанный (без личных данных) пример ответа latest в `tests/fixtures/official-latest.json`.
- [ ] **Step 8: Write `docs/deye-fields.md`** — таблица: поле `Reading` → путь в ответе API → единицы/знак; поле времени данных; какие эндпоинты; лимиты/частота, если указаны; есть ли история и с какой глубиной. **Решение-развилка:** если токен/данные получить нельзя — записать причину, Task 2 пропустить и выполнить Task 3.
- [ ] **Step 9: Commit (пользователь)** — предложить: `chore: scaffold project, config and Deye API discovery`.

---

### Task 2: Модель Reading и официальный адаптер

**Files:**
- Create: `src/deye/types.ts`, `src/deye/official.ts`
- Test: `tests/official-map.test.ts` (использует `tests/fixtures/official-latest.json`)

**Interfaces:**
- Consumes: `Config`, `sha256Hex`, `docs/deye-fields.md`.
- Produces:
  ```ts
  interface Reading {
    ts: number;                 // data time from Deye, epoch ms (NOT poll time)
    soc: number | null;         // %
    batteryPowerW: number | null; // >0 charging, <0 discharging
    gridVoltages: (number | null)[]; // [L1, L2, L3]
    gridStatusOn: boolean | null;    // explicit flag if API has one
    gridPowerW: number | null;
    loadPowerW: number | null;       // "Нагрузка"
    upsLoadPowerW: number | null;    // "UPS-Load"
    pvPowerW: number | null;
    batteryVoltage: number | null;
    batteryTempC: number | null;
    phaseLoadW: (number | null)[];   // per-phase load if available
    batteryCapacityKwh: number | null; // if API exposes it
  }
  interface Interval { start: number; end: number | null } // epoch ms; end null = ongoing
  interface DataSource {
    latest(): Promise<Reading>;
    history(fromMs: number, toMs: number): Promise<Reading[]>; // [] if unsupported
  }
  class OfficialDeyeSource implements DataSource { constructor(cfg: Config, fetchFn?: typeof fetch) }
  function mapOfficialLatest(json: unknown): Reading
  ```

- [ ] **Step 1: Write failing tests:**
  - `maps fixture to Reading` — `mapOfficialLatest(fixture)` даёт `ts` = время данных из фикстуры в ms, `soc`, `batteryPowerW` с правильным знаком (разряд < 0), 3 напряжения сети — значения из фикстуры (вписать конкретные числа после Task 1).
  - `missing fields become null` — `mapOfficialLatest({...fixture без полей сети})` → `gridVoltages` `[null,null,null]`, не бросает.
  - `refreshes token once on 401` — fake `fetchFn`: token → `T1`; latest → 401; token → `T2`; latest → 200. `await src.latest()` успешен, token запрошен 2 раза.
  - `throws after second 401` — оба latest 401 → `latest()` rejects (poller трактует как «нет данных»).
- [ ] **Step 2: Run** `npx vitest run tests/official-map.test.ts` → FAIL.
- [ ] **Step 3: Implement** `mapOfficialLatest` по `docs/deye-fields.md`; `OfficialDeyeSource`: кэш токена до истечения (минус 5 мин), один повтор при 401, таймаут запроса 15 с (`AbortSignal.timeout`), `history()` — если в Task 1 история найдена, иначе `[]`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit (пользователь)** — `feat: Deye official OpenAPI data source`.

---

### Task 3 (условная): Неофициальный адаптер

Выполнять **только** если Task 1 показала, что официальный доступ невозможен или не даёт нужных полей.

**Files:**
- Create: `src/deye/unofficial.ts`, `tests/fixtures/unofficial-latest.json`
- Modify: `docs/deye-fields.md` (раздел «unofficial»)
- Test: `tests/unofficial-map.test.ts`

**Interfaces:**
- Produces: `class UnofficialDeyeSource implements DataSource`, `mapUnofficialLatest(json: unknown): Reading` — тот же `Reading`.

- [ ] **Step 1: Discover** — пользователь сам логинится в веб-версию Deye Cloud в Chrome; агент через DevTools/network смотрит, какие запросы отдают данные станции (логин-эндпоинт, формат токена, эндпоинт realtime). Агент пароли не вводит. Записать в `docs/deye-fields.md`.
- [ ] **Step 2: Write failing tests** — как в Task 2: `maps fixture to Reading`, `missing fields become null`, `re-login once on auth error`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement**. **Step 5: Run** → PASS.
- [ ] **Step 6: Commit (пользователь)** — `feat: Deye unofficial app API fallback source`.

---

### Task 4: Классификация сети и прогнозы

**Files:**
- Create: `src/domain/grid.ts`, `src/domain/forecast.ts`
- Test: `tests/grid.test.ts`, `tests/forecast.test.ts`

**Interfaces:**
- Consumes: `Reading`.
- Produces:
  ```ts
  type GridState = 'on' | 'off';
  interface GridSample { state: GridState | null; missingPhases: ('L1'|'L2'|'L3')[]; ambiguous: boolean }
  function classifyGrid(r: Reading, offV: number, okV: number): GridSample
  function runtimeHours(soc: number, loadW: number, capacityKwh: number, reservePct: number): number | null
  function timeToFullMin(soc: number, chargeW: number, capacityKwh: number): number | null
  ```
- Rules: phase `v < offV` → off; `v >= okV` → on; between → ambiguous. Grid `off` if any phase off (missingPhases = those). `gridStatusOn` present and agrees with voltages → not ambiguous; contradicts → ambiguous, state by flag. All voltages null → state by flag, `ambiguous = (flag === null)`, `state = null` if no flag.

- [ ] **Step 1: Write failing tests:**
  - `all phases ~230 → on, not ambiguous` — `[229,231,230]` → `{state:'on', missingPhases:[], ambiguous:false}`.
  - `one phase 0 → off with L2` — `[230,0,231]` → `{state:'off', missingPhases:['L2'], ambiguous:false}`.
  - `all zero → off` — `[0,0,0]` → off, `['L1','L2','L3']`.
  - `borderline 120V → ambiguous` — `[230,120,230]` → `ambiguous:true`.
  - `no voltages, no flag → null state` — `{state:null, ambiguous:true}`.
  - `runtimeHours` — `runtimeHours(72, 211, 24, 10)` ≈ `70.5` (±0.1); `loadW <= 0` → `null`; `soc <= reserve` → `0`.
  - `timeToFullMin` — `timeToFullMin(26, 3200, 24)` ≈ `333` (±1); `chargeW < 100` → `null`; `soc >= 100` → `0`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit (пользователь)** — `feat: grid classification and battery forecasts`.

---

### Task 5: Детектор событий (state machine)

**Files:**
- Create: `src/domain/detector.ts`
- Test: `tests/detector.test.ts`

**Interfaces:**
- Consumes: `Reading`, `classifyGrid`, `GridSample`.
- Produces:
  ```ts
  interface DetectorConfig { offV: number; okV: number; staleMs: number; thresholds: number[] }
  interface DetectorState {
    grid: GridState | null;
    pending: { state: GridState; ts: number } | null;   // awaiting 2nd sample (ambiguous)
    lastTs: number | null;
    stale: boolean;
    staleSinceTs: number | null;
    outage: { startTs: number; startApprox: boolean; approxFromTs: number | null; thresholdsSent: number[]; missingPhases: string[] } | null;
    charge: { startTs: number | null; fullSent: boolean };
  }
  type DetectorEvent =
    | { type: 'outage_started'; ts: number; approxFromTs: number | null; missingPhases: string[]; reading: Reading }
    | { type: 'outage_ended'; ts: number; approxFromTs: number | null; startTs: number; reading: Reading }
    | { type: 'battery_low'; ts: number; threshold: number; outageStartTs: number; reading: Reading }
    | { type: 'battery_full'; ts: number; chargeStartTs: number | null }
    | { type: 'data_stale'; sinceTs: number }
    | { type: 'data_resumed'; ts: number; gapFromTs: number };
  const initialState: DetectorState
  function stepReading(s: DetectorState, r: Reading, cfg: DetectorConfig): { state: DetectorState; events: DetectorEvent[] }
  function stepTick(s: DetectorState, nowMs: number, cfg: DetectorConfig): { state: DetectorState; events: DetectorEvent[] }
  ```
- Rules (from spec §6.1–6.2):
  - `r.ts <= s.lastTs` → no-op (duplicate/old).
  - First reading ever (`grid === null`): set grid, **no event**; if off → `outage` with `startTs = r.ts, startApprox = true`.
  - Change, not ambiguous → event at `r.ts`. Ambiguous → `pending`; confirmed by next new reading with same state (event ts = pending.ts); different → drop pending.
  - If `r.ts - lastTs > staleMs` and state changed → event with `approxFromTs = lastTs`.
  - Was stale and new reading arrives → `data_resumed {ts: r.ts, gapFromTs: staleSinceTs ?? lastTs}`, `stale=false` (emitted before grid events).
  - `battery_low`: only while outage; on each reading, among thresholds `>= soc` not yet sent, emit **one** event for the lowest; mark all crossed as sent.
  - `battery_full`: grid on, `soc >= 100`, `!fullSent` → emit, `fullSent=true`; reset `fullSent=false` and `charge.startTs = r.ts` when `soc < 98` and `batteryPowerW > 0` first time.
  - `stepTick`: `!stale && lastTs && now - lastTs > staleMs` → `data_stale {sinceTs: lastTs}`, `stale=true`, `staleSinceTs=lastTs`.
  - State must be JSON-serializable (persisted by poller).

- [ ] **Step 1: Write failing tests** (helper `rd(ts, volts, soc, battW)` builds a Reading):
  - `first reading sets state silently` — events `[]`.
  - `on→off clear emits outage_started at reading ts` with `missingPhases ['L1','L2','L3']`.
  - `ambiguous change waits for confirmation` — 1st borderline → no event; 2nd off → `outage_started` with `ts` of 1st.
  - `ignores duplicate reading timestamp` — same `ts` twice while pending → still no event.
  - `off→on emits outage_ended with startTs`.
  - `change across gap has approxFromTs` — lastTs=t, next at t+20min (staleMs 15min) off → `approxFromTs === t`.
  - `battery_low emits once per threshold, lowest only` — soc 55→45 → threshold 50; 45→25 → one event threshold 30 (20 not crossed); 25→24 → none.
  - `battery_low only during outage` — grid on, soc 25 → none.
  - `battery_full once per cycle` — on, soc 99→100 → event; 100 again → none; drops to 90 charging → back to 100 → event.
  - `stepTick emits data_stale once`, then new reading → `data_resumed` with `gapFromTs`.
  - `restores state without re-emitting outage_started` — `JSON.parse(JSON.stringify(state))` mid-outage, next off reading → no events.
- [ ] **Step 2: Run** `npx vitest run tests/detector.test.ts` → FAIL.
- [ ] **Step 3: Implement** per rules.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit (пользователь)** — `feat: outage/battery/staleness event detector`.

---

### Task 6: Хранилище SQLite

**Files:**
- Create: `src/storage/db.ts`, `src/storage/repo.ts`

**Interfaces:**
- Consumes: `Reading`, `Interval` (Task 2), `DetectorState`.
- Produces:
  ```ts
  function openDb(path: string): Database   // WAL, runs migrations (user_version)
  interface OutageRow extends Interval { id: number; startApprox: boolean; startSoc: number | null; endSoc: number | null; missingPhases: string }
  type UserStatus = 'pending' | 'approved' | 'rejected' | 'blocked';
  interface UserRow { tgId: number; name: string; username: string | null; status: UserStatus; muted: boolean; createdAt: number }
  class Repo {
    constructor(db: Database)
    insertReading(r: Reading): boolean            // false if ts exists (UNIQUE ts)
    latestReading(): Reading | null
    readingsBetween(from: number, to: number): Reading[]
    openOutage(startTs: number, approx: boolean, soc: number|null, missing: string[]): void
    closeOutage(endTs: number, soc: number|null): void
    outagesOverlapping(from: number, to: number): OutageRow[]
    insertGap(from: number, to: number): void
    gapsOverlapping(from: number, to: number): Interval[]
    getState(): DetectorState | null; saveState(s: DetectorState): void   // kv table
    upsertPendingUser(u: { tgId: number; name: string; username: string | null }): UserRow
    setUserStatus(tgId: number, s: UserStatus): void
    setMuted(tgId: number, muted: boolean): void
    getUser(tgId: number): UserRow | null
    listUsers(): UserRow[]; approvedUsers(): UserRow[]; deleteUser(tgId: number): void
    purgeOlderThan(cutoffMs: number): { readings: number; outages: number; gaps: number } // outages by end (open never purged)
  }
  ```
- Tables: `readings(ts INTEGER PRIMARY KEY, json TEXT)`, `outages`, `gaps`, `users`, `kv(key PRIMARY KEY, value)`. Индексы по времени.

- [ ] **Step 1: Implement** `openDb`, `Repo`.
- [ ] **Step 2: Verify** — `npm run typecheck`; scratch-скрипт (не коммитить) на временной БД: вставить 2 замера с одинаковым ts → второй `false`; `purgeOlderThan` удаляет старые. Ожидание: числа совпадают.
- [ ] **Step 3: Commit (пользователь)** — `feat: SQLite storage`.

---

### Task 7: Статистика

**Files:**
- Create: `src/domain/stats.ts`
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `Interval`, `Reading` (Task 2).
- Produces:
  ```ts
  type SegState = 'on' | 'off' | 'unknown';
  interface Segment { start: number; end: number; state: SegState }
  interface Summary { onMs: number; offMs: number; unknownMs: number; outageCount: number; longestOutage: { start: number; ms: number } | null }
  function buildTimeline(from: number, to: number, outages: Interval[], gaps: Interval[], nowMs: number): Segment[] // clipped to [from, min(to, now)], unknown overrides off/on, open outage ends at now
  function summarize(segs: Segment[], outages: Interval[], from: number, to: number): Summary // outageCount = outages overlapping range
  function hourStrip(dayStartMs: number, segs: Segment[], zone: string): string // 🟩/🟥/⬜ per local hour, majority state; 23/24/25 cells
  function dayRange(dateIso: string, zone: string): { from: number; to: number }
  function weekRange(anyDateIso: string, zone: string): { from: number; to: number }   // Mon–Sun
  function monthRange(anyDateIso: string, zone: string): { from: number; to: number }
  function minSoc(readings: Reading[]): { soc: number; ts: number } | null
  function dischargedKwh(readings: Reading[]): number  // integrate negative batteryPowerW, trapezoid, skip gaps > 15 min
  ```

- [ ] **Step 1: Write failing tests:**
  - `day with three outages` — день 2026-11-03 Kyiv, outages 04:17–07:35, 13:00–15:10, 21:48–22:40 → `offMs` = 6 ч 20 мин, `onMs` = 17 ч 40 мин, `outageCount 3`, `hourStrip` = `🟩🟩🟩🟩🟥🟥🟥🟥🟩🟩🟩🟩🟩🟥🟥🟩🟩🟩🟩🟩🟩🟩🟥🟩`.
  - `outage across midnight splits` — 22:00–02:00 → в первом дне off 2 ч, во втором 2 ч; `outageCount` 1 в обоих.
  - `DST day sums to 25h` — `dayRange('2026-10-25','Europe/Kyiv')` длиной 25 ч; `onMs+offMs+unknownMs` = 25 ч; `hourStrip` длиной 25 клеток.
  - `gap becomes unknown, overrides outage` — outage 10:00–12:00, gap 11:00–13:00 → off 1 ч, unknown 2 ч.
  - `today counted up to now` — now = 12:00 → сумма = 12 ч.
  - `weekRange is Mon–Sun` — `weekRange('2026-11-04')` начинается 2026-11-02 00:00 Kyiv.
  - `dischargedKwh` — два замера −1000 Вт с интервалом 1 ч → `1.0`; с интервалом 20 мин при gap-пороге 15 → `0`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (luxon для локальных границ). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit (пользователь)** — `feat: outage statistics aggregation`.

---

### Task 8: Форматирование сообщений

Тексты — по макетам `design-v1.html` (панель, уведомления, день, неделя) и `charge-eta.html`; HTML parse mode Telegram (`<b>`, `<i>`, `<pre>`, `<blockquote>`). Экранировать `<>&` во всех подставляемых строках.

**Files:**
- Create: `src/bot/format.ts`
- Test: `tests/format.test.ts`

**Interfaces:**
- Consumes: `Reading`, `GridSample`, `DetectorEvent`, `Summary`, `Segment`, forecast functions, `Config` (capacity, reserve, zone).
- Produces:
  ```ts
  interface Msg { text: string; silent: boolean }
  interface PanelCtx { reading: Reading | null; grid: GridSample | null; outageStartTs: number | null; lastOnTs: number | null; nowMs: number; staleAfterMs: number }
  function socBar(soc: number): string                     // 10 cells ▰/▱, round
  function fmtDuration(ms: number): string                 // "3 ч 18 мин", "52 мин", "2 сут 3 ч"
  function renderPanel(c: PanelCtx, cfg: Config): string
  function renderBattery(c: PanelCtx, cfg: Config): string
  function renderLoad(c: PanelCtx, cfg: Config): string
  function renderEvent(e: DetectorEvent, cfg: Config): Msg
  function renderDay(dateIso: string, sum: Summary, strip: string, outages: Interval[], minSoc: {soc:number;ts:number}|null, kwh: number, cfg: Config, earliestIso: string): string
  function renderWeek(rangeLabel: string, rows: { label: string; sum: Summary }[], total: Summary, prevTotal: Summary | null): string
  function renderMonth(rangeLabel: string, rows: { label: string; sum: Summary }[], total: Summary): string
  function renderAccessRequest(name: string, username: string | null): string
  ```
- Copy (verbatim first lines): `🔴 Свет пропал · HH:mm`, `🟢 Свет вернулся · HH:mm`, `🪫 Батарея N%`, `🔋 Батареи заряжены · 100%`, `⚠️ Нет данных от Deye N мин`, `✅ Данные от Deye снова поступают`. Approx time: `🔴 Свет пропал · между HH:mm и HH:mm`. Missing some phases: доп. строка `нет L2`. Silent: `battery_full`, `data_stale`, `data_resumed`.
- Panel: header `🟢 Свет есть` / `🔴 Света нет — дом на батареях` (+ `· нет L2` при частичной); `без света уже X · с HH:mm`; `<pre>` блок; «хватит ≈» при разряде, «до 100% ≈ … (к ~HH:mm)» при заряде; `обновлено N мин назад`; если данные старше `staleAfterMs` — заголовок `⚠️ Нет свежих данных от Deye` и пометка «последние данные HH:mm».
- Unknown time in stats: строка `❔ Нет данных  X` только если > 0.

- [ ] **Step 1: Write failing tests:**
  - `socBar(72) === '▰▰▰▰▰▰▰▱▱▱'`; `socBar(0)`, `socBar(100)`.
  - `fmtDuration(198*60000) === '3 ч 18 мин'`; `fmtDuration(52*60000) === '52 мин'`.
  - `outage_started first line` — text начинается с `<b>🔴 Свет пропал · 04:17</b>`, `silent false`, содержит `72%`, `211 Вт`, `≈ 70 ч`.
  - `outage_ended shows duration and ETA` — содержит `10 ч 45 мин`, `до 100% ≈ 5 ч 33 мин` (soc 26, charge 3200 W, 24 kWh), `silent false`.
  - `approx event uses between` — `approxFromTs` set → `между 04:05 и 04:25`.
  - `battery_full is silent`.
  - `panel stale warning` — reading 20 мин назад при staleAfter 15 → содержит `Нет свежих данных`.
  - `escapes html` — `renderAccessRequest('<b>x', null)` содержит `&lt;b&gt;x`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit (пользователь)** — `feat: Telegram message formatting`.

---

### Task 9: Poller, Notifier, backfill, retention

**Files:**
- Create: `src/bot/notifier.ts`, `src/poller.ts`
- Test: `tests/notifier.test.ts`

**Interfaces:**
- Consumes: `DataSource`, `Repo`, `stepReading/stepTick/initialState`, `renderEvent`, `Config`.
- Produces:
  ```ts
  interface SendApi { sendMessage(chatId: number, text: string, opts: { parse_mode: 'HTML'; disable_notification: boolean }): Promise<unknown> }
  function broadcast(api: SendApi, users: UserRow[], msg: Msg, onBlocked: (tgId: number) => void): Promise<{ sent: number; failed: number }>
  class Poller {
    constructor(src: DataSource, repo: Repo, cfg: Config, notify: (e: DetectorEvent) => Promise<void>)
    start(): void; stop(): void
    pollNow(): Promise<void>   // used by 🔄 Обновить; rate-limited to 1 per 20 s
    backfill(): Promise<void>  // replay history without notifications
  }
  ```
- Behavior:
  - `broadcast`: per user `disable_notification = msg.silent || user.muted`; error 403 → `onBlocked`; other errors → log, continue; 429 → wait `retry_after`, retry once.
  - Poll loop every `pollIntervalSec`: `latest()` → if `repo.insertReading` true → `stepReading`; always `stepTick(now)`; apply events to DB (`outage_started` → `openOutage`, `outage_ended` → `closeOutage`, `data_resumed` → `insertGap(gapFromTs, ts)`), `saveState`, then `notify` each. Fetch errors → only log (stale path handles it); backoff ×2 up to 10 min, reset on success.
  - On start: load state (`getState() ?? initialState`), run `backfill()` once (history from `max(lastTs, now−90d)` to now, insert readings, replay via `stepReading`, apply DB effects, **no notify**), then start loop.
  - Retention: on start and every 24 h `purgeOlderThan(now − 90 d)`, log counts.

- [ ] **Step 1: Write failing tests** (`tests/notifier.test.ts`, fake `SendApi`):
  - `broadcast continues when one user blocked` — 3 users, 2nd throws `{error_code:403}` → `sent 2`, `onBlocked` called with 2nd id.
  - `muted user gets silent` — muted user → `disable_notification: true` even if `msg.silent=false`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `broadcast`, `Poller`. **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit (пользователь)** — `feat: poller, notifier, backfill and retention`.

---

### Task 10: Telegram-бот: доступ, панель, статистика, настройки

**Files:**
- Create: `src/bot/keyboards.ts`, `src/bot/bot.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `Repo`, `Poller.pollNow`, `classifyGrid`, stats functions, render functions, `broadcast`, `Config`.
- Produces: `createBot(cfg: Config, repo: Repo, poller: Poller): Bot`; `main()` в `src/main.ts` (config → db → source по `deyeSource` → poller → bot.start(), graceful stop на SIGTERM).
- Callback data (≤ 64 bytes): `v:panel`, `v:bat`, `v:load`, `v:refresh`, `s:d:YYYY-MM-DD`, `s:w:YYYY-MM-DD` (понедельник), `s:m:YYYY-MM`, `u:ok:<id>`, `u:no:<id>`, `u:del:<id>`, `set:mute`.
- Keyboards (по макету): панель — `[🏠 Панель][🔋 Батарея][⚡ Нагрузка]`, `[📊 Статистика][🔄 Обновить]`, активная вкладка помечена; день — `[‹ 2 ноя][День][4 ноя ›]`, `[Неделя][Месяц][🏠 Панель]`; неделя/месяц — `[‹ Пред.][Неделя|Месяц][След. ›]`, `[День][Месяц|Неделя][🏠 Панель]`. Стрелки скрываются за границей 90 дней и в будущем.
- Behavior:
  - Ignore non-private chats.
  - Access middleware: admin (`adminTelegramId`) всегда approved (upsert при первом /start). Неизвестный → `upsertPendingUser`, ему `🔒 Доступ к Deye Home по приглашению. Запрос отправлен владельцу.`, админу — `👤 Имя (@username) хочет доступ к Deye Home` + `[✅ Разрешить][❌ Отклонить]`. Повторный /start от pending не шлёт админу повторно. Rejected/blocked — тот же ответ без уведомления админа. Approved при одобрении получает приветствие + панель.
  - `/start` и `🏠 Панель` → `renderPanel` (новое сообщение на /start; на кнопках — `editMessageText`). Ошибку «message is not modified» игнорировать. «📊 Статистика» → текущий день.
  - `🔄 Обновить` → `poller.pollNow()` затем перерисовка; `answerCallbackQuery` всегда (иначе крутится часик).
  - `/users` (только админ): список `имя · статус` + `[Удалить]` для каждого (кроме себя).
  - `/settings`: `🔔 Звук уведомлений: вкл/выкл` + кнопка переключения.
  - Команды в меню бота (`setMyCommands`): start, settings; для админа также users.

- [ ] **Step 1: Implement** keyboards, bot, main.
- [ ] **Step 2: Verify build** — `npm run typecheck && npm run build` → без ошибок; `npm test` → все PASS.
- [ ] **Step 3: Manual check (локально, с пользователем)** — пользователь создаёт бота у @BotFather, вписывает токен и свой ID в `.env`; `npm run build && npm start`. Чек-лист: /start → панель с реальными данными; вкладки переключаются в том же сообщении; «Статистика» → день, ‹ › листают; неделя/месяц; второй аккаунт → запрос админу → ✅ → получил панель; `/settings` переключает звук; `/users` удаляет. Остановить процесс.
- [ ] **Step 4: Commit (пользователь)** — `feat: Telegram bot UI and access control`.

---

### Task 11: Docker и развёртывание на NAS

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`, `README.md` (установка/обновление, 1 экран)

**Interfaces:**
- Consumes: всё приложение; `.env` на NAS.

- [ ] **Step 1: Dockerfile** — multi-stage на `node:24-bookworm-slim` (glibc → better-sqlite3 без сборки); build stage: `npm ci`, `npm run build`; runtime: `npm ci --omit=dev`, `dist/`, `USER node`, `CMD ["node","dist/main.js"]`, `TZ=Europe/Kyiv`.
- [ ] **Step 2: compose.yaml** — сервис `deye-bot`, `build: .`, `env_file: .env`, `volumes: ./data:/app/data`, `DB_PATH=/app/data/deye.db`, `restart: unless-stopped`, `logging: json-file, max-size 10m, max-file 3`.
- [ ] **Step 3: Verify locally** — `docker build -t deye-bot .` → успешно (если Docker на Mac есть; иначе пропустить и сказать об этом).
- [ ] **Step 4: Copy to NAS** — `rsync -av -e "ssh -p 22" --exclude node_modules --exclude dist --exclude .env --exclude data ./ admin@192.168.1.10:/volume1/docker/deye-bot/`. Создать там `data/` (владелец — uid контейнера `node`=1000 или chmod, чтобы контейнер мог писать). Пользователь сам создаёт `/volume1/docker/deye-bot/.env` по `.env.example`.
- [ ] **Step 5: Start (пользователь)** — `cd /volume1/docker/deye-bot && sudo docker compose up -d --build`; затем `sudo docker compose logs --tail 50`. Ожидание: в логе «backfill done», «poll ok», без секретов; бот отвечает на /start с панелью.
- [ ] **Step 6: Live check** — пользователь подтверждает, что NAS, роутер и ONT провайдера питаются от резервного выхода Deye. По желанию — тест: выключить вводной автомат на ~10 мин → пришло «🔴 Свет пропал», затем «🟢 Свет вернулся» с длительностью и прогнозом зарядки.
- [ ] **Step 7: Commit (пользователь)** — `feat: Docker deployment for Synology`.
