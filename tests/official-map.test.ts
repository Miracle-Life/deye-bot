import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DeyeAuthError, mapBatteryConfig, mapBatteryLimits, mapEnergyFrames, mapOfficialAlerts, mapOfficialHistory, mapOfficialLatest, OfficialDeyeSource } from '../src/deye/official.js';

const latestFixture = JSON.parse(readFileSync(new URL('./fixtures/official-latest.json', import.meta.url), 'utf8'));
const historyFixture = JSON.parse(readFileSync(new URL('./fixtures/official-history.json', import.meta.url), 'utf8'));

const cfg = loadConfig({
  TELEGRAM_TOKEN: 't',
  ADMIN_TELEGRAM_ID: '1',
  DEYE_APP_ID: 'app',
  DEYE_APP_SECRET: 's',
  DEYE_EMAIL: 'e',
  DEYE_PASSWORD: 'p',
  DEYE_STATION_ID: '42',
  DEYE_DEVICE_SN: '2400000001',
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const latestOk = {
  success: true,
  deviceDataList: [{ deviceSn: '2400000001', collectionTime: 1793762000, dataList: [{ key: 'SOC', value: '72', unit: '%' }] }],
};

function fakeFetch(script: Response[]) {
  const urls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const next = script.shift();
    if (!next) throw new Error('unexpected request ' + url);
    return next;
  }) as typeof fetch;
  return { fn, urls };
}

describe('OfficialDeyeSource auth', () => {
  it('refreshes token once on 401', async () => {
    const { fn, urls } = fakeFetch([
      json(200, { success: true, accessToken: 'T1', expiresIn: '5183999' }),
      json(401, { success: false }),
      json(200, { success: true, accessToken: 'T2', expiresIn: '5183999' }),
      json(200, latestOk),
    ]);
    const r = await new OfficialDeyeSource(cfg, fn).latest();
    expect(r.ts).toBe(1793762000 * 1000);
    expect(urls.filter((u) => u.includes('/account/token')).length).toBe(2);
  });

  it('throws after second 401', async () => {
    const { fn } = fakeFetch([
      json(200, { success: true, accessToken: 'T1', expiresIn: '5183999' }),
      json(401, {}),
      json(200, { success: true, accessToken: 'T2', expiresIn: '5183999' }),
      json(401, {}),
    ]);
    await expect(new OfficialDeyeSource(cfg, fn).latest()).rejects.toThrow();
  });

  it('rejected credentials raise DeyeAuthError', async () => {
    const { fn } = fakeFetch([json(200, { success: false, msg: 'wrong password' })]);
    await expect(new OfficialDeyeSource(cfg, fn).latest()).rejects.toBeInstanceOf(DeyeAuthError);
  });

  it('drops the token after a Deye-level error (HTTP 200, success:false) so the next call logs in again', async () => {
    const { fn, urls } = fakeFetch([
      json(200, { success: true, accessToken: 'T1', expiresIn: '5183999' }),
      json(200, { success: false, code: '2101019', msg: 'auth invalid token' }),
      json(200, { success: true, accessToken: 'T2', expiresIn: '5183999' }),
      json(200, latestOk),
    ]);
    const src = new OfficialDeyeSource(cfg, fn);
    await expect(src.latest()).rejects.toThrow();
    await src.latest();
    expect(urls.filter((u) => u.includes('/account/token')).length).toBe(2);
  });

  it('keeps the token after a non-auth Deye error (no extra logins)', async () => {
    const { fn, urls } = fakeFetch([
      json(200, { success: true, accessToken: 'T1', expiresIn: '5183999' }),
      json(200, { success: false, code: '2101006', msg: 'invalid param' }),
      json(200, latestOk),
    ]);
    const src = new OfficialDeyeSource(cfg, fn);
    await expect(src.latest()).rejects.toThrow();
    await src.latest();
    expect(urls.filter((u) => u.includes('/account/token')).length).toBe(1);
  });

  it('survives a non-numeric expiresIn', async () => {
    const { fn, urls } = fakeFetch([json(200, { success: true, accessToken: 'T1', expiresIn: 'soon' }), json(200, latestOk), json(200, latestOk)]);
    const src = new OfficialDeyeSource(cfg, fn);
    await src.latest();
    await src.latest();
    expect(urls.filter((u) => u.includes('/account/token')).length).toBe(1);
  });

  it('reuses cached token', async () => {
    const { fn, urls } = fakeFetch([json(200, { success: true, accessToken: 'T1', expiresIn: '5183999' }), json(200, latestOk), json(200, latestOk)]);
    const src = new OfficialDeyeSource(cfg, fn);
    await src.latest();
    await src.latest();
    expect(urls.filter((u) => u.includes('/account/token')).length).toBe(1);
  });
});

describe('mapOfficialLatest', () => {
  it('maps fixture to Reading', () => {
    const r = mapOfficialLatest(latestFixture);
    expect(r.ts).toBe(1793763267 * 1000);
    expect(r.soc).toBe(69);
    expect(r.batteryPowerW).toBe(-1126); // Deye: positive = discharge
    expect(r.gridVoltages).toEqual([0, 0, 0]);
    expect(r.gridPowerW).toBe(0);
    expect(r.loadPowerW).toBe(1072);
    expect(r.upsLoadPowerW).toBe(1072);
    expect(r.pvPowerW).toBe(0);
    expect(r.batteryVoltage).toBe(52.66);
    expect(r.batteryTempC).toBe(25);
    expect(r.inverterTempC).toBe(41.6);
    expect(r.phaseLoadW).toEqual([0, 118, 954]);
    expect(r.batteryCapacityKwh).toBeCloseTo(23.55, 2); // 460 Ah × 51.2 V
  });

  it('missing fields become null', () => {
    const dev = latestFixture.deviceDataList[0];
    const trimmed = { deviceDataList: [{ ...dev, dataList: dev.dataList.filter((i: { key: string }) => !i.key.startsWith('GridVoltage')) }] };
    const r = mapOfficialLatest(trimmed);
    expect(r.gridVoltages).toEqual([null, null, null]);
  });
});

describe('mapOfficialHistory', () => {
  it('maps frames to readings', () => {
    const rs = mapOfficialHistory(historyFixture);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ ts: 1793743264000, soc: 80, batteryPowerW: -560, gridVoltages: [0, 0, 0] });
  });
});

describe('OfficialDeyeSource.history', () => {
  it('requests one local day per call and filters range', async () => {
    const bodies: any[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/account/token')) return json(200, { success: true, accessToken: 'T', expiresIn: '5183999' });
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, historyFixture);
    }) as typeof fetch;
    const src = new OfficialDeyeSource(cfg, fn, 0);
    // 2026-11-03 23:00 → 2026-11-04 02:00 Kyiv spans two local days.
    const from = Date.UTC(2026, 10, 3, 21, 0);
    const to = Date.UTC(2026, 10, 4, 0, 0);
    const rs = await src.history(from, to);
    expect(bodies.map((b) => b.startAt)).toEqual(['2026-11-04', '2026-11-03']); // newest first
    expect(bodies[0]).toMatchObject({ startAt: '2026-11-04', endAt: '2026-11-04', granularity: 1 });
    expect(bodies[0].measurePoints.length).toBeLessThanOrEqual(5);
    expect(rs.every((r) => r.ts >= from && r.ts < to)).toBe(true);
  });
});

describe('OfficialDeyeSource.history limits', () => {
  const DAY = 86_400_000;
  const empty = { success: true, dataList: [] };

  function src(handler: (body: any) => Response) {
    const bodies: any[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/account/token')) return json(200, { success: true, accessToken: 'T', expiresIn: '5183999' });
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return handler(body);
    }) as typeof fetch;
    return { s: new OfficialDeyeSource(cfg, fn, 0, 0), bodies };
  }

  it('stops after 3 consecutive empty days once data was seen', async () => {
    const { s, bodies } = src((b) => (b.startAt === '2026-11-04' ? json(200, historyFixture) : json(200, empty)));
    const to = Date.UTC(2026, 10, 4, 12, 0);
    await s.history(to - 90 * DAY, to);
    expect(bodies.length).toBe(4); // 11-04 with data, then 3 empty days
  });

  it('returns partial data when rate limit persists', async () => {
    const { s } = src((b) =>
      b.startAt === '2026-11-03' ? json(200, { success: false, msg: 'too many requests' }) : json(200, historyFixture),
    );
    const to = Date.UTC(2026, 10, 4, 12, 0);
    const rs = await s.history(to - 10 * DAY, to);
    expect(rs.length).toBe(2); // fixture frames from 11-04 only
  });
});

describe('mapOfficialAlerts', () => {
  it('maps alert items defensively (seconds → ms, open alerts have no end)', () => {
    const list = mapOfficialAlerts({
      alertList: [
        { alertId: 7, alertCode: 'F13', alertName: 'Grid Lost', level: 'warning', startTime: 1793762000, endTime: null },
        { code: 56, name: 'DC bus low', alertTime: 1793762000000, recoverTime: 1793762600000 },
      ],
    });
    expect(list[0]).toEqual({ id: '7', code: 'F13', name: 'Grid Lost', level: 'warning', startTs: 1793762000000, endTs: null });
    expect(list[1]).toMatchObject({ code: '56', name: 'DC bus low', startTs: 1793762000000, endTs: 1793762600000 });
    expect(list[1]!.id).toBe('56@1793762000000');
  });

  it('empty or missing list', () => {
    expect(mapOfficialAlerts({ total: 0, alertList: [] })).toEqual([]);
    expect(mapOfficialAlerts(null)).toEqual([]);
  });
});

describe('mapEnergyFrames', () => {
  it('maps daily counters per frame', () => {
    const fr = mapEnergyFrames({
      dataList: [
        { time: 1793743264, itemList: [{ key: 'DailyEnergyPurchased', value: '4.50' }, { key: 'DailyConsumption', value: '4.40' }, { key: 'PVDailyPowerGenerationActive', value: '0.00' }] },
      ],
    });
    expect(fr).toEqual([{ ts: 1793743264000, purchased: 4.5, consumption: 4.4, charge: null, discharge: null, pv: 0 }]);
  });
});

describe('mapBatteryConfig', () => {
  it('reads the max charge current', () => {
    expect(mapBatteryConfig({ code: '1000000', success: true, maxChargeCurrent: 150, maxDischargeCurrent: 180 })).toBe(150);
  });

  it('returns null when missing or not positive', () => {
    expect(mapBatteryConfig({ success: true })).toBeNull();
    expect(mapBatteryConfig({ maxChargeCurrent: 0 })).toBeNull();
    expect(mapBatteryConfig(null)).toBeNull();
  });

  it('reads both charge and discharge limits', () => {
    expect(mapBatteryLimits({ maxChargeCurrent: 150, maxDischargeCurrent: 180 })).toEqual({ chargeA: 150, dischargeA: 180 });
    expect(mapBatteryLimits({ maxChargeCurrent: 150 })).toEqual({ chargeA: 150, dischargeA: null });
  });

  it('maps lifetime battery counters', () => {
    const r = mapOfficialLatest({
      success: true,
      deviceDataList: [{ collectionTime: 1, dataList: [{ key: 'TotalDischargeEnergy', value: '10.80', unit: 'kWh' }, { key: 'TotalChargeEnergy', value: '18.10', unit: 'kWh' }] }],
    });
    expect([r.dischargeTotalKwh, r.chargeTotalKwh]).toEqual([10.8, 18.1]);
  });

  it('maps the inverter rated power', () => {
    const r = mapOfficialLatest({ success: true, deviceDataList: [{ collectionTime: 1, dataList: [{ key: 'RatedPower', value: '10000.00', unit: 'W' }] }] });
    expect(r.ratedPowerW).toBe(10_000);
  });
});

describe('mapOfficialAlerts without a name', () => {
  it('leaves the name empty instead of a Russian placeholder', () => {
    const [a] = mapOfficialAlerts({ success: true, alertList: [{ alertId: 7, alertCode: 'F13', alertStartTime: 1793762000 }] });
    expect(a?.name).toBe('');
  });
});
