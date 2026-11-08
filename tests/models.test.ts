import { DateTime } from 'luxon';
import { dicts } from '../src/i18n/index.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { emptyReading } from '../src/deye/types.js';
import { batteryModel, dayModel, moneyModel, panelModel, periodModel, scheduleModel } from '../src/render/models.js';
import { monthSummary } from '../src/domain/energy.js';

const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Kyiv' }).toMillis();
const MIN = 60_000;
const ru = dicts.ru;
const H = 60 * MIN;
const base = { ...emptyReading(0), batteryVoltage: 52.66, batteryTempC: 25, pvPowerW: 0, gridPowerW: 0, batteryCapacityKwh: 23.552 };

describe('panelModel', () => {
  const now = at('2026-11-04T05:50');
  const charging = { ...base, ts: now - MIN, soc: 85, batteryPowerW: 4100, gridPowerW: 7000, upsLoadPowerW: 2900, batteryVoltage: 54.3, gridVoltages: [222, 222, 222] };
  const on = { state: 'on' as const, missingPhases: [], ambiguous: false };
  const ctx = (over: object) => ({ reading: charging, grid: on, outageStartTs: null, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: { chargeA: 150, dischargeA: 180 }, ...over });

  it('grid load: total, zone, house/battery split, charge limit', () => {
    const m = panelModel(ctx({}), cfg, ru);
    expect(m.load).toMatchObject({ value: '7.00', max: '10 кВт', zone: 'orange', legend: { home: { label: 'Дом', kw: '2.90' }, battery: { label: 'Батареи', kw: '4.10' }, limit: 'лимит заряда от сети 80 А ≈ 4.34 кВт' } });
    expect(m.load!.homeFrac).toBeCloseTo(0.29);
    expect(m.load!.batteryFrac).toBeCloseTo(0.41);
  });

  it('battery mode: house draw against the discharge/inverter limit', () => {
    const outage = { ...base, ts: now - MIN, soc: 60, batteryPowerW: -2400, upsLoadPowerW: 2400, batteryVoltage: 54.3, ratedPowerW: 10_000, gridVoltages: [0, 0, 0] };
    const m = panelModel(ctx({ reading: outage, grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false } }), cfg, ru);
    expect(m.load).toMatchObject({ label: 'От батарей', value: '2.40', max: '8.70 кВт', zone: 'green', legend: { home: { label: 'Дом', kw: '2.40' }, battery: null, limit: 'лимит разряда 180 А ≈ 8.70 кВт · инвертор 10 кВт' } });
    expect(m.load!.homeFrac).toBeCloseTo(2400 / 8699);
    expect(m.load!.scale).toEqual({ yellow: 0.5, orange: 0.7, red: 7000 / 8699 });
  });

  it('battery mode: rated power (10 kW) when no limit is known', () => {
    const outage = { ...base, ts: now - MIN, soc: 60, batteryPowerW: -2400, upsLoadPowerW: 2400, gridVoltages: [0, 0, 0] };
    expect(panelModel(ctx({ reading: outage, grid: { state: 'off', missingPhases: [], ambiguous: false }, limits: null }), cfg, ru).load!.max).toBe('10 кВт');
  });

  it('a reported 0 V battery voltage uses the nominal voltage, never "0 kW" or NaN', () => {
    const out = { ...base, ts: now - MIN, soc: 60, batteryPowerW: -2400, upsLoadPowerW: 2400, batteryVoltage: 0, ratedPowerW: 10_000, gridVoltages: [0, 0, 0] };
    const o = panelModel(ctx({ reading: out, grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false } }), cfg, ru).load!;
    expect(o.max).toBe('8.20 кВт');
    expect(Number.isFinite(o.homeFrac)).toBe(true);
    const grid = { ...charging, batteryVoltage: 0 };
    expect(panelModel(ctx({ reading: grid }), cfg, ru).load!.legend.limit).toBe('лимит заряда от сети 80 А ≈ 4.10 кВт');
  });

  it('real-world numbers: grid 8.43 kW, outage 1 kW at 53.1 V', () => {
    const grid = { ...base, ts: now - MIN, soc: 96, gridPowerW: 8432, batteryPowerW: 4154, upsLoadPowerW: 4074, batteryVoltage: 54.84, ratedPowerW: 10_000, gridVoltages: [230, 230, 230] };
    const g = panelModel(ctx({ reading: grid }), { ...cfg, gridLoadMaxKw: 8, gridChargeA: 80 }, dicts.en);
    expect(g.load).toMatchObject({ max: '10 kW', zone: 'red', legend: { limit: 'grid charge limit 80 A ≈ 4.39 kW' } });
    const out = { ...base, ts: now - MIN, soc: 93, batteryPowerW: -1050, upsLoadPowerW: 1000, batteryVoltage: 53.1, ratedPowerW: 10_000, gridVoltages: [0, 0, 0] };
    const o = panelModel(ctx({ reading: out, grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false } }), cfg, dicts.en);
    expect(o.load!.max).toBe('8.51 kW');
    expect(o.load!.legend.limit).toContain('180 A ≈ 8.51 kW');
  });

  it('panel in English', () => {
    const m = panelModel(ctx({}), cfg, dicts.en);
    expect(m.status.label).toBe('Power is on');
    expect(m.tiles[0]!.label).toBe('Home');
    expect(m.load!.max).toBe('10 kW');
    expect(m.load!.label).toBe('From grid');
  });

  it('grid load: scale from the bands and threshold', () => {
    expect(panelModel(ctx({}), cfg, ru).load!.scale).toEqual({ yellow: 0.5, orange: 0.65, red: 0.8 });
  });

  it('outage: status, discharge, runtime, red grid tile', () => {
    const m = panelModel(
      {
        reading: { ...base, ts: now - 3 * MIN, soc: 69, batteryPowerW: -1126, upsLoadPowerW: 1072, gridVoltages: [0, 0, 0] },
        grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false },
        outageStartTs: at('2026-11-04T00:41'),
        lastOnTs: null,
        nowMs: now,
        staleAfterMs: 15 * MIN,
        limits: null,
      },
      cfg,
      ru,
    );
    expect(m.status).toEqual({ kind: 'off', label: 'Света нет · 5 ч 9 мин' });
    expect(m.soc).toBe(69);
    expect(m.socKwh).toBe('16.3 кВт·ч');
    expect(m.flow).toEqual({ label: 'Разряд', value: '1.13 кВт' });
    expect(m.eta).toEqual({ label: 'Хватит примерно на', value: '12 ч 58 мин', tone: 'amber', color: '#76e25a' });
    expect(m.tiles.find((t) => t.icon === 'grid')).toMatchObject({ value: 'нет', tone: 'red' });
    expect(m.tiles.find((t) => t.icon === 'home')).toMatchObject({ value: '1.07', unit: 'кВт' });
    expect(m.stale).toBeNull();
    expect(m.caption).toBe('🔴 <b>Света нет</b> · с 00:41');
  });

  it('grid on, batteries idle: house runs from the grid; reserve at this load, coloured by hours', () => {
    const r = { ...base, ts: now - MIN, soc: 100, batteryPowerW: -45, upsLoadPowerW: 1420, gridPowerW: 1420, batteryCapacityKwh: 23.552, gridVoltages: [234, 234, 234] };
    const uk = dicts.uk;
    const full = panelModel(ctx({ reading: r }), cfg, uk);
    expect(full.flow).toEqual({ label: 'Будинок живиться від мережі', value: '1.42 кВт' });
    expect(full.eta).toMatchObject({ label: 'Батареї повні · при 1.42 кВт вистачить на', tone: 'green', color: '#76e25a' });
    expect(full.eta!.value).toBe('≈ 14 год 56 хв');
    const part = panelModel(ctx({ reading: { ...r, soc: 36, upsLoadPowerW: 600 } }), cfg, uk);
    expect(part.flow!.value).toBe('600 Вт');
    expect(part.eta!.label).toBe('Батареї 36% · при 600 Вт вистачить на');
    // Beyond a week: "> 7 доб", no "≈" in front.
    expect(panelModel(ctx({ reading: { ...r, upsLoadPowerW: 90 } }), cfg, uk).eta!.value).toBe('> 7 доб');
    expect(panelModel(ctx({ reading: { ...r, upsLoadPowerW: 250 } }), cfg, uk).eta!.value).toBe('≈ 3 доб 12 год');
    expect(panelModel(ctx({ reading: { ...r, upsLoadPowerW: 250 } }), cfg, uk).eta!.sub).toBe('(84 год)');
    // Charging or a real discharge keeps the old wording.
    expect(panelModel(ctx({ reading: { ...r, batteryPowerW: 4100 } }), cfg, uk).flow!.label).toBe('Заряд');
    expect(panelModel(ctx({ reading: { ...r, batteryPowerW: -800 } }), cfg, uk).flow!.label).toBe('Розряд');
  });

  it('caption says how long the power was off during the first hour after it is back', () => {
    const r = { ...base, ts: now - MIN, soc: 90, batteryPowerW: 0, upsLoadPowerW: 400, gridVoltages: [229, 230, 231] };
    const back = (end: number) => panelModel(ctx({ reading: r, lastOnTs: end, lastOutageStartTs: now - 4 * H }), cfg, dicts.uk).caption;
    expect(back(now - 10 * MIN)).toBe('🟢 <b>Світло є</b> · не було 3 год 50 хв');
    expect(back(now - 61 * MIN)).toBe('🟢 <b>Світло є</b>');
  });

  it('grid back and charging: time to full', () => {
    const m = panelModel(
      {
        reading: { ...base, ts: now - MIN, soc: 26, batteryPowerW: 3200, upsLoadPowerW: 400, gridVoltages: [229, 230, 231] },
        grid: { state: 'on', missingPhases: [], ambiguous: false },
        outageStartTs: null,
        lastOnTs: at('2026-11-04T05:30'),
        nowMs: now,
        staleAfterMs: 15 * MIN,
        limits: null,
      },
      cfg,
      ru,
    );
    expect(m.status).toEqual({ kind: 'on', label: 'Свет есть' });
    expect(m.flow).toEqual({ label: 'Заряд', value: '+3.20 кВт' });
    expect(m.eta).toMatchObject({ label: 'До 100% ≈', tone: 'green' });
    expect(m.tiles.find((t) => t.icon === 'grid')).toMatchObject({ value: '230', unit: 'В', tone: 'green' });
  });

  it('outage that just started says so instead of "0 мин"', () => {
    const m = panelModel(
      { reading: { ...base, ts: now, soc: 80, batteryPowerW: -600, upsLoadPowerW: 600, gridVoltages: [0, 0, 0] }, grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false }, outageStartTs: now - 20_000, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: null },
      cfg,
      ru,
    );
    expect(m.status.label).toBe('Света нет · только что');
  });

  it('stale data is flagged', () => {
    const m = panelModel(
      { reading: { ...base, ts: now - 40 * MIN, soc: 50, batteryPowerW: 0, upsLoadPowerW: 300, gridVoltages: [230, 230, 230] }, grid: { state: 'on', missingPhases: [], ambiguous: false }, outageStartTs: null, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: null },
      cfg,
      ru,
    );
    expect(m.stale).toBe('Нет свежих данных · последние в 05:10');
  });
});

describe('dayModel', () => {
  it('segments cover the day as fractions, future marked', () => {
    const from = at('2026-11-04T00:00');
    const to = at('2026-11-05T00:00');
    const segs = [
      { start: from, end: from + 6 * H, state: 'on' as const },
      { start: from + 6 * H, end: from + 12 * H, state: 'off' as const },
    ];
    const m = dayModel('2026-11-04', segs, { onMs: 6 * H, offMs: 6 * H, unknownMs: 0, outageCount: 1, longestOutage: null }, [{ start: from + 6 * H, end: null }], null, 0, cfg, { from, to }, from + 12 * H, from, ru);
    expect(m.title).toBe('Среда, 4 ноября');
    expect(m.bar.map((b) => [b.x0, b.x1, b.state])).toEqual([
      [0, 0.25, 'on'],
      [0.25, 0.5, 'off'],
      [0.5, 1, 'future'],
    ]);
    expect(m.stats).toEqual([
      { label: 'Свет был', value: '6 ч', tone: 'green' },
      { label: 'Не было', value: '6 ч', tone: 'red' },
      { label: 'Отключений', value: '1', tone: 'plain' },
    ]);
    expect(m.outages).toEqual(['06:00 – сейчас · 6 ч']);
  });
});

describe('periodModel', () => {
  it('rows carry on/off fractions and text', () => {
    const sum = (on: number, off: number, n: number) => ({ onMs: on * H, offMs: off * H, unknownMs: 0, outageCount: n, longestOutage: null });
    const m = periodModel('2 – 8 ноября', [{ label: 'Пн 02', sum: sum(18, 6, 2) }, { label: 'Вт 03', sum: sum(24, 0, 0) }], sum(42, 6, 2), null, cfg, ru);
    expect(m.rows[0]).toMatchObject({ label: 'Пн 02', on: 0.75, off: 0.25, text: '6 ч', tone: 'red' });
    expect(m.rows[1]).toMatchObject({ text: 'весь день', tone: 'green' });
    expect(m.stats[0]).toEqual({ label: 'Свет был', value: '88%', tone: 'green' });
  });

  it('partial day is scaled to its full span', () => {
    const sum = { onMs: 3 * H, offMs: 3 * H, unknownMs: 0, outageCount: 1, longestOutage: null };
    const m = periodModel('w', [{ label: 'Ср 04', sum, spanMs: 24 * H }], sum, null, cfg, ru);
    expect(m.rows[0]).toMatchObject({ on: 0.125, off: 0.125 });
  });
});

describe('moneyModel', () => {
  it('total, zone tiles, per-day bars and notes', () => {
    const yasno = { dayPrice: 4.32, nightPrice: 2.16, nightFrom: 23, nightTo: 7 };
    const days = [
      { date: '2026-11-01', dayKwh: 10, nightKwh: 5, consumption: 14, charge: 2, discharge: 1, pv: 0 },
      { date: '2026-11-02', dayKwh: 0, nightKwh: 0, consumption: 6, charge: 0, discharge: 6, pv: 0 },
    ];
    const s = monthSummary(days, yasno, '2026-11', at('2026-11-02T12:00'), 'Europe/Kyiv', null);
    const m = moneyModel(s, '2026-11', yasno, days, at('2026-11-02T12:00'), cfg, ru);
    expect(m.title).toBe('Ноябрь 2026');
    expect(m.total).toBe('54.00 ₴');
    expect(m.tiles.map((t) => [t.label, t.value])).toEqual([
      ['День · 4.32 ₴', '43.20'],
      ['Ночь · 2.16 ₴', '10.80'],
    ]);
    expect(m.bars).toHaveLength(30);
    expect(m.bars[0]).toMatchObject({ day: 0.8, night: 0.2 });
    expect(m.bars[1]).toMatchObject({ day: 0, night: 0, today: true });
    expect(m.notes).toContain('Ночной тариф сэкономил 10.80 ₴');
  });

  it('average per day leaves out the unfinished today', () => {
    const yasno = { dayPrice: 4.32, nightPrice: 2.16, nightFrom: 23, nightTo: 7 };
    const full = (d: string) => ({ date: d, dayKwh: 10, nightKwh: 10, consumption: 20, charge: 0, discharge: 0, pv: 0 });
    const days = [full('2026-11-01'), full('2026-11-02'), full('2026-11-03'), { ...full('2026-11-04'), dayKwh: 0, nightKwh: 1 }];
    const now = at('2026-11-04T01:00');
    const m = moneyModel(monthSummary(days, yasno, '2026-11', now, 'Europe/Kyiv', null), '2026-11', yasno, days, now, cfg, ru);
    expect(m.notes).toContain('В среднем 64.80 ₴ в день');
  });
});

describe('cards in Ukrainian', () => {
  it('day title uses the Ukrainian weekday and month', () => {
    const { from, to } = { from: at('2026-11-04T00:00'), to: at('2026-11-05T00:00') };
    const m = dayModel('2026-11-04', [], { onMs: 0, offMs: 0, unknownMs: 0, outageCount: 0, longestOutage: null }, [], null, 0, cfg, { from, to }, from + H, from, dicts.uk);
    expect(m.title).toBe('Середа, 4 листопада');
    expect(m.stats[0]!.label).toBe('Світло було');
  });
});

describe('day card on a DST day', () => {
  it('puts hour ticks at local hours (25-hour day)', () => {
    const from = at('2026-10-25T00:00');
    const to = at('2026-10-26T00:00');
    const m = dayModel('2026-10-25', [], { onMs: 0, offMs: 0, unknownMs: 0, outageCount: 0, longestOutage: null }, [], null, 0, cfg, { from, to }, to, from, ru);
    const six = m.ticks.find((t) => t.label === '06')!;
    expect(six.x).toBeCloseTo((at('2026-10-25T06:00') - from) / (to - from), 4);
  });
});

describe('panel schedule tile', () => {
  const now = at('2026-11-04T21:00');
  const off = { state: 'off' as const, missingPhases: ['L1', 'L2', 'L3'], ambiguous: false };
  const on = { state: 'on' as const, missingPhases: [], ambiguous: false };
  const base2 = { ...base, ts: now - MIN, batteryCapacityKwh: 20, gridVoltages: [0, 0, 0] };
  const ctx = (over: object) => ({ reading: base2, grid: off, outageStartTs: null, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: null, schedule: null, ...over });
  const sch = (state: object, stale = false) => ({ state, stale, fetchedAt: now - 10 * MIN });
  const uk = dicts.uk;

  it('no address → no tile', () => {
    expect(panelModel(ctx({}), cfg, uk).schedule).toBeNull();
  });

  it('off: power-on time and a battery warning with advice', () => {
    const r = { ...base2, soc: 30, batteryPowerW: -1200, upsLoadPowerW: 1200, pvPowerW: 0 };
    const m = panelModel(ctx({ reading: r, schedule: sch({ kind: 'off-until', until: at('2026-11-05T06:00'), endsAtDayEdge: false }) }), cfg, uk);
    expect(m.schedule!.label).toBe('За графіком');
    expect(m.schedule!.title).toBe('Світло о 06:00 · через 9 год');
    expect(m.schedule!.lines[0]).toEqual({ text: '⚠️ Батарей вистачить до ≈ 00:20 · знизьте до ~440 Вт', tone: 'red' });
  });

  it('off: enough charge', () => {
    const r = { ...base2, soc: 95, batteryPowerW: -300, upsLoadPowerW: 300 };
    const m = panelModel(ctx({ reading: r, schedule: sch({ kind: 'off-until', until: at('2026-11-04T23:00'), endsAtDayEdge: false }) }), cfg, uk);
    expect(m.schedule!.lines[0]).toEqual({ text: '✓ Батарей вистачить із запасом', tone: 'green' });
  });

  it('on inside the slot: not off yet vs back early', () => {
    const r = { ...base2, soc: 80, batteryPowerW: 0, gridVoltages: [230, 230, 230] };
    const slot = { kind: 'on-in-slot', from: at('2026-11-04T20:00'), until: at('2026-11-05T05:30') };
    const waiting = panelModel(ctx({ reading: r, grid: on, schedule: sch({ ...slot, early: false }) }), cfg, uk).schedule!;
    expect(waiting).toMatchObject({ title: 'Відключення за графіком вже йде з 20:00', tone: 'amber' });
    expect(waiting.lines[0]).toEqual({ text: 'світло поки є · до 05:30', tone: 'muted' });
    const early = panelModel(ctx({ reading: r, grid: on, schedule: sch({ ...slot, early: true }) }), cfg, uk).schedule!;
    expect(early).toMatchObject({ title: 'Світло дали раніше графіка', tone: 'green' });
    expect(early.lines[0]).toEqual({ text: 'за графіком відключення до 05:30, можуть вимкнути знову', tone: 'amber' });
  });

  it('on: next outage with the projected charge', () => {
    const r = { ...base2, soc: 80, batteryPowerW: 4000, gridVoltages: [230, 230, 230] };
    const m = panelModel(ctx({ reading: r, grid: on, schedule: sch({ kind: 'next', start: at('2026-11-04T22:00'), end: at('2026-11-05T06:00') }) }), cfg, uk);
    expect(m.schedule!.title).toBe('Відключення о 22:00 · через 1 год');
    expect(m.schedule!.lines[0]!.text).toBe('до 06:00 · батареї до відключення ≈ 100%');
  });

  it('on: preliminary no outages, and the stale mark', () => {
    const m = panelModel(ctx({ grid: on, schedule: sch({ kind: 'none-today', preliminary: true }, true) }), cfg, uk);
    expect(m.schedule!.title).toBe('Сьогодні без відключень');
    expect(m.schedule!.lines.map((l) => l.text)).toEqual(['попередньо · графік може змінитися', '⚠️ дані від 20:50 · можуть бути застарілими']);
  });

  it('verdict uses the 15-min average discharge when given', () => {
    const r = { ...base2, soc: 95, batteryPowerW: -3000, upsLoadPowerW: 3000 }; // a kettle right now
    const m = panelModel(ctx({ reading: r, schedule: { ...sch({ kind: 'off-until', until: at('2026-11-04T23:00'), endsAtDayEdge: false }), dischargeW: 400 } }), cfg, uk);
    expect(m.schedule!.lines[0]).toEqual({ text: '✓ Батарей вистачить із запасом', tone: 'green' });
  });

  it('no battery verdict against a 24:00 edge (tomorrow unpublished)', () => {
    const r = { ...base2, soc: 30, batteryPowerW: -1200, upsLoadPowerW: 1200 };
    const m = panelModel(ctx({ reading: r, schedule: sch({ kind: 'off-until', until: at('2026-11-05T00:00'), endsAtDayEdge: true }) }), cfg, uk);
    expect(m.schedule!.lines.map((l) => l.text)).toEqual(['графік на завтра ще не опубліковано']);
  });

  it('power-on time already passed within grace reads as running late', () => {
    const m = panelModel(ctx({ schedule: sch({ kind: 'off-until', until: at('2026-11-04T20:50'), endsAtDayEdge: false }) }), cfg, uk);
    expect(m.schedule!.title).toBe('Світло мало бути о 20:50');
  });

  it('emergency', () => {
    const m = panelModel(ctx({ schedule: sch({ kind: 'emergency' }) }), cfg, uk);
    expect(m.schedule!.title).toBe('Екстрені відключення');
    expect(m.schedule!.tone).toBe('red');
  });
});

describe('scheduleModel', () => {
  it('builds the card from the real YASNO response', async () => {
    const { readFileSync } = await import('node:fs');
    const { parsePlanned } = await import('../src/schedule/yasno.js');
    const json = JSON.parse(readFileSync(new URL('./fixtures/yasno/planned-outages.json', import.meta.url), 'utf8'));
    const s = parsePlanned(json, '52.1', at('2026-11-04T20:30'));
    const now = at('2026-11-04T21:00');
    const m = scheduleModel(s, { kind: 'off-until', until: at('2026-11-05T00:00'), endsAtDayEdge: true }, false, now, cfg, dicts.uk);
    expect(m.title).toBe('Графік · група 52.1');
    expect(m.updated).toBe('оновлено о 20:15');
    expect(m.days[0]).toMatchObject({ title: 'Сьогодні, ср 4', total: '12 год без світла', spans: '10:00 – 20:00 · 22:00 – 24:00' });
    expect(m.days[0]!.bar[0]!.x0).toBeCloseTo(10 / 24, 4);
    expect(m.days[0]!.nowX).toBeCloseTo(21 / 24, 4);
    expect(m.days[1]).toMatchObject({ title: 'Завтра, чт 5', total: 'графік ще не опубліковано', spans: null, nowX: null });
    expect(m.status.title).toBe('Відключення до 24:00 · ще 3 год');
    expect(m.caption).toContain('10:00 – 20:00 · 22:00 – 24:00');
  });

  it('labels days by date: after midnight yesterday is dropped', async () => {
    const { readFileSync } = await import('node:fs');
    const { parsePlanned } = await import('../src/schedule/yasno.js');
    const json = JSON.parse(readFileSync(new URL('./fixtures/yasno/planned-outages.json', import.meta.url), 'utf8'));
    const s = parsePlanned(json, '52.1', at('2026-11-04T23:50'));
    const m = scheduleModel(s, { kind: 'today-unpublished' }, false, at('2026-11-05T00:05'), cfg, dicts.uk);
    expect(m.days.map((d) => d.title)).toEqual(['Сьогодні, чт 5']);
  });
});

describe('batteryModel', () => {
  const base3 = {
    nominalKwh: 23.55,
    capacity: { estimateKwh: null, pct: null, trendPct: null },
    cycles: 48.4,
    ratedCycles: 6000,
    wear: { byCyclesPct: 0.8, byCapacityPct: null },
    tempNow: 26,
    tempMax30: 31,
    hoursAbove35: 0,
    hoursAboveLimit: 0,
    limitC: 45,
    today: '2026-11-04',
    days: [{ date: '2026-11-03', maxTempC: 29 }, { date: '2026-11-04', maxTempC: 31 }],
  };

  it('honest when there is no deep discharge yet', () => {
    const m = batteryModel(base3, dicts.uk);
    expect(m.title).toBe("Здоров'я батарей");
    expect(m.tiles[0]).toMatchObject({ label: 'Ємність', value: '—', note: 'ще мало даних — потрібен розряд ≥ 20 %' });
    expect(m.tiles[1]).toMatchObject({ label: 'Цикли', value: '≈ 48', note: 'із ~6000 за паспортом' });
    expect(m.tiles[2]).toMatchObject({ label: 'Знос', value: '≈ 0.8 %', note: 'за циклами' });
    expect(m.tiles[3]).toMatchObject({ label: 'Температура', value: '26°C', note: 'макс за 30 днів 31°C · вище 35°C: 0 хв' });
    expect(m.bars).toHaveLength(2);
  });

  it('temperature colour follows the current value; time above the limit is shown', () => {
    const m = batteryModel({ ...base3, tempNow: 27, hoursAbove35: 2.5, hoursAboveLimit: 0.5 }, dicts.uk);
    expect(m.tiles[3]!.tone).toBe('plain');
    expect(m.tiles[3]!.note).toBe('макс за 30 днів 31°C · вище 35°C: 2 год 30 хв · вище 45°C: 30 хв');
  });

  it('bars sit at their date: a missing day leaves a gap', () => {
    const m = batteryModel({ ...base3, today: '2026-11-04', days: [{ date: '2026-11-01', maxTempC: 29 }, { date: '2026-11-04', maxTempC: 31 }] }, dicts.uk);
    expect(m.bars.map((b) => Math.round(b.x * 30))).toEqual([26, 29]);
  });

  it('capacity estimate with trend and wear by capacity', () => {
    const m = batteryModel({ ...base3, capacity: { estimateKwh: 22.8, pct: 97, trendPct: -1 }, wear: { byCyclesPct: 0.8, byCapacityPct: 3.2 } }, dicts.uk);
    expect(m.tiles[0]).toMatchObject({ value: '≈ 22.8 кВт·год', note: '97 % від паспорта (23.6) · за місяць −1.0 %' });
    expect(m.tiles[2]!.note).toBe('за циклами · за ємністю ≈ 3.2 %');
  });
});
