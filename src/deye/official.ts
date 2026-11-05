import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { errInfo, log } from '../log.js';
import type { EnergyFrame } from '../domain/energy.js';
import type { DeyeAlert } from '../domain/watch.js';
import { emptyReading, type BatteryLimits, type DataSource, type Reading } from './types.js';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Deye rejected our credentials or token — needs the owner's attention. */
export class DeyeAuthError extends Error {}
class AuthError extends DeyeAuthError {} // 401/403 on a data call: retried once with a fresh token

const TOKEN_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

type DataItem = { key: string; value: string | number | null; unit?: string };

// Keys confirmed against real /device/latest responses (docs/deye-fields.md).
const KEYS = {
  soc: [/^soc$/i, /^batterysoc$/i],
  batteryPowerW: [/^batterypower$/i, /^totalbatterypower$/i],
  gridV1: [/^gridvoltagel1(n)?$/i, /^gridvoltagea$/i],
  gridV2: [/^gridvoltagel2(n)?$/i, /^gridvoltageb$/i],
  gridV3: [/^gridvoltagel3(n)?$/i, /^gridvoltagec$/i],
  gridPowerW: [/^totalgridpower$/i, /^gridpower$/i],
  ratedPowerW: [/^ratedpower$/i],
  dischargeTotal: [/^totaldischargeenergy$/i],
  chargeTotal: [/^totalchargeenergy$/i],
  loadPowerW: [/^totalconsumptionpower$/i, /^loadpower$/i],
  upsLoadPowerW: [/^upsloadpower$/i, /^totalupsloadpower$/i, /^upspower$/i],
  pvPowerW: [/^totalsolarpower$/i, /^totaldcinputpower$/i, /^pvpower$/i],
  batteryVoltage: [/^batteryvoltage$/i],
  batteryTempC: [/^temperature-\s*battery$/i, /^batterytemperature$/i],
  inverterTempC: [/^ac temperature$/i, /^inverter ?temperature$/i, /^radiator ?temperature$/i],
  loadL1: [/^loadpowerl1$/i],
  loadL2: [/^loadpowerl2$/i],
  loadL3: [/^loadpowerl3$/i],
  capacityAh: [/^batteryratedcapacity$/i],
};

const NOMINAL_BATTERY_V = 51.2; // LV LiFePO4 pack
const MAX_EMPTY_DAYS = 3;
const RATE_LIMIT_RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Device history accepts at most 5 measure points per request.
const HISTORY_POINTS = ['SOC', 'BatteryPower', 'GridVoltageL1', 'GridVoltageL2', 'GridVoltageL3'];

function pick(items: DataItem[], patterns: RegExp[]): number | null {
  for (const p of patterns) {
    const hit = items.find((i) => p.test(i.key));
    if (hit && hit.value !== null && hit.value !== '') {
      const n = Number(hit.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function mapItems(items: DataItem[], ts: number): Reading {
  const battery = pick(items, KEYS.batteryPowerW);
  const ah = pick(items, KEYS.capacityAh);
  return {
    ...emptyReading(ts),
    soc: pick(items, KEYS.soc),
    // Deye reports discharge as positive; we use >0 = charging.
    batteryPowerW: battery === null ? null : battery === 0 ? 0 : -battery,
    gridVoltages: [pick(items, KEYS.gridV1), pick(items, KEYS.gridV2), pick(items, KEYS.gridV3)],
    gridPowerW: pick(items, KEYS.gridPowerW),
    ratedPowerW: pick(items, KEYS.ratedPowerW),
    dischargeTotalKwh: pick(items, KEYS.dischargeTotal),
    chargeTotalKwh: pick(items, KEYS.chargeTotal),
    loadPowerW: pick(items, KEYS.loadPowerW),
    upsLoadPowerW: pick(items, KEYS.upsLoadPowerW),
    pvPowerW: pick(items, KEYS.pvPowerW),
    batteryVoltage: pick(items, KEYS.batteryVoltage),
    batteryTempC: pick(items, KEYS.batteryTempC),
    inverterTempC: pick(items, KEYS.inverterTempC),
    phaseLoadW: [pick(items, KEYS.loadL1), pick(items, KEYS.loadL2), pick(items, KEYS.loadL3)],
    batteryCapacityKwh: ah === null || ah <= 0 ? null : (ah * NOMINAL_BATTERY_V) / 1000,
  };
}

export function mapOfficialLatest(json: unknown): Reading {
  const dev = (json as any)?.deviceDataList?.[0];
  if (!dev) throw new Error('Deye: no device data in response');
  const ts = Number(dev.collectionTime) * 1000;
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('Deye: missing collectionTime');
  return mapItems(Array.isArray(dev.dataList) ? dev.dataList : [], ts);
}

export function mapOfficialHistory(json: unknown): Reading[] {
  const frames: any[] = (json as any)?.dataList ?? [];
  return frames
    .map((f) => ({ ts: Number(f.time) * 1000, items: Array.isArray(f.itemList) ? f.itemList : [] }))
    .filter((f) => Number.isFinite(f.ts) && f.ts > 0)
    .map((f) => mapItems(f.items, f.ts));
}

const ENERGY_POINTS = ['DailyEnergyPurchased', 'DailyConsumption', 'DailyChargingEnergy', 'DailyDischargingEnergy', 'PVDailyPowerGenerationActive'];

const positive = (v: unknown) => {
  const n = Number(v);
  return v !== undefined && v !== null && Number.isFinite(n) && n > 0 ? n : null;
};

/** `/config/battery` → max charge current, A. */
export function mapBatteryConfig(json: unknown): number | null {
  return positive((json as { maxChargeCurrent?: unknown } | null)?.maxChargeCurrent);
}

/** `/config/battery` → max charge and discharge currents, A. */
export function mapBatteryLimits(json: unknown): BatteryLimits {
  const j = json as { maxChargeCurrent?: unknown; maxDischargeCurrent?: unknown } | null;
  return { chargeA: positive(j?.maxChargeCurrent), dischargeA: positive(j?.maxDischargeCurrent) };
}

export function mapEnergyFrames(json: unknown): EnergyFrame[] {
  const frames: any[] = (json as any)?.dataList ?? [];
  return frames
    .map((f) => {
      const items: DataItem[] = Array.isArray(f.itemList) ? f.itemList : [];
      const v = (k: string) => pick(items, [new RegExp(`^${k}$`, 'i')]);
      return {
        ts: Number(f.time) * 1000,
        purchased: v('DailyEnergyPurchased'),
        consumption: v('DailyConsumption'),
        charge: v('DailyChargingEnergy'),
        discharge: v('DailyDischargingEnergy'),
        pv: v('PVDailyPowerGenerationActive'),
      };
    })
    .filter((f) => Number.isFinite(f.ts) && f.ts > 0);
}

const first = (o: any, keys: string[]) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null && v !== '');
const toMs = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n; // seconds or ms
};

// Field names are not documented and no alert has been seen yet — accept the likely variants.
export function mapOfficialAlerts(json: unknown): DeyeAlert[] {
  const items: any[] = (json as any)?.alertList ?? [];
  return items.map((a) => {
    const code = first(a, ['alertCode', 'code', 'alarmCode', 'faultCode']);
    const startTs = toMs(first(a, ['startTime', 'alertTime', 'occurTime', 'startTimestamp', 'time']));
    const id = first(a, ['alertId', 'id', 'alarmId']);
    return {
      id: id !== undefined ? String(id) : `${code ?? '?'}@${startTs ?? 0}`,
      code: code !== undefined ? String(code) : null,
      name: String(first(a, ['alertName', 'alertNameEn', 'name', 'alarmName', 'description', 'alertDesc']) ?? ''),
      level: first(a, ['level', 'alertLevel', 'grade']) !== undefined ? String(first(a, ['level', 'alertLevel', 'grade'])) : null,
      startTs,
      endTs: toMs(first(a, ['endTime', 'recoverTime', 'endTimestamp', 'recoveryTime'])),
    };
  });
}

export class OfficialDeyeSource implements DataSource {
  private loggedAlertShape = false;
  private token: { value: string; expiresAt: number } | null = null;
  private deviceSn: string | null;

  constructor(
    private cfg: Config,
    private fetchFn: typeof fetch = fetch,
    private historyDelayMs = 500,
    private rateLimitWaitMs = 15_000,
  ) {
    this.deviceSn = cfg.deyeDeviceSn;
  }

  async latest(): Promise<Reading> {
    const sn = await this.resolveDevice();
    return mapOfficialLatest(await this.call('/device/latest', { deviceList: [sn] }));
  }

  /** Inverter settings: max battery charge/discharge current, A. */
  async batteryLimits(): Promise<BatteryLimits> {
    return mapBatteryLimits(await this.call('/config/battery', { deviceSn: await this.resolveDevice() }));
  }

  /** Intraday energy counters for one local day (for the day/night tariff split). */
  async energyFrames(dateIso: string): Promise<EnergyFrame[]> {
    const sn = await this.resolveDevice();
    const body = { deviceSn: sn, granularity: 1, startAt: dateIso, endAt: dateIso, measurePoints: ENERGY_POINTS };
    for (let attempt = 0; ; attempt++) {
      try {
        return mapEnergyFrames(await this.call('/device/history', body));
      } catch (e) {
        const limited = e instanceof Error && /too many/i.test(e.message);
        if (!limited || attempt >= RATE_LIMIT_RETRIES) throw e;
        await sleep(this.rateLimitWaitMs);
      }
    }
  }

  async alerts(fromMs: number, toMs: number): Promise<DeyeAlert[]> {
    const sn = await this.resolveDevice();
    const body = { deviceSn: sn, startTimestamp: Math.floor(fromMs / 1000), endTimestamp: Math.floor(toMs / 1000), page: 1, size: 50 };
    const json = await this.call('/device/alertList', body);
    const raw = json?.alertList?.[0];
    if (raw && !this.loggedAlertShape) {
      this.loggedAlertShape = true;
      log.info('deye alert sample', { raw }); // to confirm the undocumented fields
    }
    return mapOfficialAlerts(json);
  }

  /**
   * One request per local day (API limit), newest first. Stops after 3 empty days in a row
   * (before install) or on a persistent rate limit, returning what was collected.
   */
  async history(fromMs: number, toMs: number): Promise<Reading[]> {
    if (toMs <= fromMs) return [];
    const sn = await this.resolveDevice();
    const z = this.cfg.timezone;
    const byTs = new Map<number, Reading>();
    const first = DateTime.fromMillis(fromMs, { zone: z }).startOf('day');
    let day = DateTime.fromMillis(toMs - 1, { zone: z }).startOf('day');
    let emptyRun = 0;
    while (day >= first && emptyRun < MAX_EMPTY_DAYS) {
      const iso = day.toISODate()!;
      let json: unknown;
      try {
        json = await this.historyDay(sn, iso);
      } catch (e) {
        log.warn('history stopped', { day: iso, ...errInfo(e) });
        break;
      }
      const rs = mapOfficialHistory(json);
      emptyRun = rs.length ? 0 : emptyRun + 1;
      for (const r of rs) if (r.ts >= fromMs && r.ts < toMs) byTs.set(r.ts, r);
      day = day.minus({ days: 1 });
      if (this.historyDelayMs) await sleep(this.historyDelayMs);
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }

  private async historyDay(sn: string, iso: string): Promise<unknown> {
    const body = { deviceSn: sn, granularity: 1, startAt: iso, endAt: iso, measurePoints: HISTORY_POINTS };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call('/device/history', body);
      } catch (e) {
        const limited = e instanceof Error && /too many/i.test(e.message);
        if (!limited || attempt >= RATE_LIMIT_RETRIES) throw e;
        await sleep(this.rateLimitWaitMs);
      }
    }
  }

  private async resolveDevice(): Promise<string> {
    if (this.deviceSn) return this.deviceSn;
    let stationId = this.cfg.deyeStationId;
    if (!stationId) {
      const list = await this.call('/station/list', { page: 1, size: 10 });
      stationId = String(list?.stationList?.[0]?.id ?? '');
      if (!stationId) throw new Error('Deye: no stations on this account');
    }
    const devs = await this.call('/station/device', { page: 1, size: 20, stationIds: [Number(stationId)] });
    const items: any[] = devs?.deviceListItems ?? [];
    const inv = items.find((d) => /inverter/i.test(String(d.deviceType))) ?? items[0];
    if (!inv?.deviceSn) throw new Error('Deye: no inverter found on station');
    this.deviceSn = String(inv.deviceSn);
    return this.deviceSn;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - TOKEN_MARGIN_MS) return this.token.value;
    const res = await this.fetchFn(`${this.cfg.deyeBaseUrl}/account/token?appId=${encodeURIComponent(this.cfg.deyeAppId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSecret: this.cfg.deyeAppSecret, email: this.cfg.deyeEmail, password: sha256Hex(this.cfg.deyePassword) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => ({}));
    const value = body?.accessToken ?? body?.data?.accessToken;
    const why = `Deye token failed: HTTP ${res.status} ${body?.msg ?? ''}`.trim();
    if (res.status === 401 || res.status === 403 || (res.ok && body?.success === false)) throw new DeyeAuthError(why);
    if (!res.ok || !value) throw new Error(why);
    const expiresInSec = Number(body?.expiresIn ?? body?.data?.expiresIn) || 3600;
    this.token = { value, expiresAt: Date.now() + expiresInSec * 1000 };
    return value;
  }

  private async call(path: string, body: unknown): Promise<any> {
    try {
      return await this.callOnce(path, body);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      this.token = null; // one retry with a fresh token
      return this.callOnce(path, body);
    }
  }

  private async callOnce(path: string, body: unknown): Promise<any> {
    const token = await this.getToken();
    const res = await this.fetchFn(this.cfg.deyeBaseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) throw new AuthError(`Deye ${path}: HTTP ${res.status}`);
    const json: any = await res.json().catch(() => null);
    // Deye reports a revoked/expired token as HTTP 200 too: log in again next time (only then, to avoid extra logins).
    if (json?.success === false && /token|auth|login|expire/i.test(String(json?.msg))) this.token = null;
    if (!res.ok || json?.success === false) throw new Error(`Deye ${path}: HTTP ${res.status} ${json?.msg ?? ''}`.trim());
    return json;
  }
}
