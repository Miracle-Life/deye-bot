# Deye bot: grid-load block + three languages — design

Date: 2026-11-04. Builds on `2026-11-04-deye-telegram-bot-design.md` (the live bot).

## Why

1. **Grid load.** The house has a limited grid connection: above ~8 kW the main breaker may trip. When the batteries charge from the grid while the house is also consuming (e.g. house 2.9 kW + charge 4.1 kW = 7.0 kW), the owner can't see the combined draw on the panel today — only the separate numbers. They want to see at a glance how close they are to the breaker, what that load is made of, and how much charge power the inverter is allowed to take.
2. **Languages.** The bot is Russian-only. The owner wants each user to choose Ukrainian, Russian or English and get everything — texts, buttons, notifications and the generated images — in that language.

Two independent parts; build the grid-load part first, then languages.

## Part 1 — Grid load

### Data (verified against Deye Cloud OpenAPI on 2026-11-04)

- Grid draw: `TotalGridPower` (already mapped to `Reading.gridPowerW`). **Builder must verify the sign** (import positive vs negative) against a live reading while charging from grid; only import counts as "from grid".
- House: `Reading.loadPowerW` (`TotalConsumptionPower`). Battery: `Reading.batteryPowerW` (>0 charging).
- Charge limit: `POST /config/battery {deviceSn}` → `maxChargeCurrent: 150` (A). Also returns `maxDischargeCurrent`, `battCapacity`. This is config, not telemetry: fetch on startup and refresh rarely (e.g. every 6 h), cache last value; if it fails, the caption just omits the limit.
- No grid-charge-current setting is exposed (`/config/tou` only gives per-slot `power: 10000`, `enableGridCharge`). Not shown.
- **Per-battery SOC: not available** via the official API. The two battery modules (`25000000E4000001`, `25000000E4000002`) and the BMS (`2400000001BM01`) are listed by `/station/device`, but `/device/latest` returns nothing and `/device/measurePoints` says "device not supported". The unofficial app API client (`src/deye/unofficial.ts`) is only a stub, so probing it means reverse-engineering the app — **out of scope** (my call, owner informed); a possible separate project later.

### Panel card — layout "A" (chosen by the owner from mockups)

A full-width "From grid" block between the ring/charge area and the four tiles:

- Big number: current grid draw, e.g. `7.0 / 8 kW`, colored by zone.
- Horizontal bar scaled 0–8 kW, split into two colored parts: to house and to batteries.
- Thin zone scale under the bar.
- Legend: `House 2.9 · Batteries 4.1` and on the right `charge limit 150 A ≈ 8.1 kW`. kW = amps × current battery voltage (fallback nominal voltage), rounded to 0.1.
- Everything else on the card stays as is (ring, "Charging / to 100%", four tiles).
- **Battery mode** (owner's request, added during build): during an outage the block becomes "From batteries" — house draw against the real limit = min(max discharge current × battery voltage, inverter rated power), e.g. `7.6 / 9.8 kW`, legend `discharge limit 180 A ≈ 9.8 kW · inverter 10 kW`. Zones by share of that limit: yellow from 50 %, orange from 70 % (my call), red from 90 % (owner chose). Hidden if neither limit is known. No alert in battery mode.
- **Shown to everyone** (owner's decision): the panel stays one card for all users, including the photo attached to household notifications. No admin/family split.
- Block is hidden when there is no grid draw (outage, or draw ≈ 0) — card looks like today.

Zones (owner fixed only "red from 7 kW"; the rest is my call): green < 4 kW, yellow 4–5.5, orange 5.5–7, red ≥ 7. Bar scale max 8 kW (breaker). Red threshold follows the alert threshold setting below; others are fixed.

Split (my call): batteries' share = min(battery charge power, grid draw), house share = grid draw − batteries' share. With sun it's approximate; that's acceptable.

### Admin alert

- Fires once when grid draw ≥ threshold (default 7 kW); "back to normal" when it drops below threshold − 0.5 kW (hysteresis). Same pattern as `stepTemps` in `src/domain/watch.ts`; state survives restarts the same way temps do.
- Audience: **admin only**.
- Text example: `⚠️ From grid 7.3 kW — house 3.1 + batteries 4.2. Breaker ~8 kW`.
- Threshold is an owner setting in `/settings` (new field, e.g. options 5, 6, 6.5, 7, 7.5 kW; default from a new env var, 7).
- Known limit: Deye cloud data updates every few minutes, so short spikes may be missed. No attempt to work around it.

## Part 2 — Languages (uk / ru / en)

- Per-user language stored in `users` (new column via migration). **Existing users get `ru`** in the migration.
- New users: auto from Telegram `language_code` — `uk` → Ukrainian, `ru` → Russian, anything else → English.
- Switch in personal `/settings` (where sound and night mode are): three buttons 🇺🇦 Українська / 🇷🇺 Русский / 🇬🇧 English.
- Translated: everything the user sees — panel, stats, money, all notifications, buttons, reply keyboard, bot command menu (`setMyCommands` per `language_code` scope or per chat), image cards (labels, units like кВт → kW, month/weekday names). Admin screens (owner settings, `/users`, status, ops/error/temp/grid-load alerts) follow the admin's language.
- Broadcasts: render text and image once per language actually used by recipients, send each user their version.
- **Watchdog worker messages are translated too** (owner's decision). The "home offline / back online" texts live in `worker/src/logic.ts` (separate Cloudflare build). Add `lang` per chat to the `Beat` payload (`src/heartbeat.ts` ↔ `worker/src/logic.ts`, kept in sync by tests), give the worker its own small uk/ru/en dictionary (incl. the h/min duration formatter), and send each chat its own language. `parseBeat` must treat a missing/unknown `lang` as `ru` so old and new versions interoperate. Deploy order: worker first (`npx wrangler deploy`, run by the owner), then the bot.
- Dates/times stay 24-hour in all languages; only month/weekday names change (my call).
- No external i18n library is required; a typed dictionary per language is fine (builder's call). Missing keys must fail typecheck, not fall back silently.

## Non-goals

- Per-battery SOC (needs the unofficial API; separate project if ever).
- Controlling the inverter (changing charge current etc.) — read-only.
- Alerts to family about grid load.
- Additional languages beyond the three.

## Anti-goals

- Existing family users suddenly seeing English.
- Alert spam when load hovers around 7 kW.
- Breaking the running bot on the NAS: all work and testing happen locally first.

## Constraints / process

- Tests are minimal by policy: pure-function vitest only in `tests/`; don't expand coverage beyond pure logic (zone/split math, hysteresis, language pick, dictionary completeness are fair game). Verify via typecheck/build plus rendered previews.
- Pin exact npm versions if any dependency is added.
- No git commits by the agent (project is not a git repo anyway).
- Local testing: the owner temporarily stops the NAS container (`sudo docker stop ...`, run by the owner) and the bot runs locally with the same token, `NODE_USE_ENV_PROXY=0 npm start`. Use a copy of the NAS DB. Deploy to NAS (tar over ssh, owner rebuilds) only after the owner has checked everything locally.
- Show the owner rendered PNG previews of new/changed cards in each language before the live test.

## Left to the builder

- Exact visual metrics of the block (follow `src/render/cards.ts` style and palette; orange is new).
- Dictionary structure and where formatting helpers live.
- How the config value is cached and refreshed.
- Ukrainian/English wording (natural, short; the owner reviews in previews).
