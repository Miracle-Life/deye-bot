# Deye OpenAPI → Reading mapping

Verified 2026-11-04 against the real station «Home Deye» (inverter SUN-10K-SG05LP3, productId `0_5411_1`) via `npm run discover`.

- Base URL: `https://eu1-developer.deyecloud.com/v1.0`, all calls `POST` with JSON body.
- Token: `POST /account/token?appId=…` body `{ appSecret, email, password: sha256hex }` → `accessToken`, `expiresIn` ≈ 60 days (seconds, string). Header: `Authorization: Bearer <token>`.
- Station: `/station/list` → `stationList[].id`; `/station/device` (`stationIds`) → `deviceListItems[]` with `deviceType` `INVERTER` / `BATTERY` / `COLLECTOR`.
- Cloud refresh: frames every ~3 min (180 s).

## `/device/latest` (`deviceList: [sn]`) → `deviceDataList[0]`

`collectionTime` (epoch **seconds**) → `Reading.ts`. `dataList[] = { key, value (string), unit }`:

| Reading | key | note |
|---|---|---|
| soc | `SOC` | % |
| batteryPowerW | `BatteryPower` | Deye: **positive = discharge** → negated |
| gridVoltages | `GridVoltageL1/L2/L3` | V, 0 during outage |
| gridStatusOn | — | `GridStatus` is a string (`Static` seen during outage); not used |
| gridPowerW | `TotalGridPower` | W |
| loadPowerW | `TotalConsumptionPower` | W (equals UPS load on this install) |
| upsLoadPowerW | `UPSLoadPower` | W |
| pvPowerW | `TotalSolarPower` | W |
| batteryVoltage | `BatteryVoltage` | V |
| batteryTempC | `Temperature- Battery` | ℃ (key has a space) |
| phaseLoadW | `LoadPowerL1/L2/L3` | W |
| batteryCapacityKwh | `BatteryRatedCapacity` | Ah × 51.2 V (460 Ah ≈ 23.6 kWh) |

## `/device/history`

`{ deviceSn, granularity: 1, startAt: 'yyyy-MM-dd', endAt: same, measurePoints: [...] }` — one local day, **max 5 measure points** (more → `2101007 list too long`; missing `endAt` → `2101006`). Response `dataList[] = { time (epoch s), itemList[] = { key, value, unit } }`.
We request `SOC, BatteryPower, GridVoltageL1, GridVoltageL2, GridVoltageL3`.

`/station/history` with granularity 1 returned no items — not used.
