import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { emptyReading } from '../src/deye/types.js';
import { diffAlerts, initialWatch, nightShortfall, shouldWarnShort, stepTemps, type DeyeAlert } from '../src/domain/watch.js';

const Z = 'Europe/Kyiv';
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();
const limits = { batteryMaxC: 45, inverterMaxC: 70 };
const temps = (b: number | null, i: number | null) => ({ ...emptyReading(0), batteryTempC: b, inverterTempC: i });

describe('initialWatch', () => {
  it('starts with grid load not high', () => {
    expect(initialWatch.gridHigh).toBe(false);
  });
});

describe('stepTemps', () => {
  it('alerts once when crossing the limit, clears after cooling 5°C', () => {
    let s = initialWatch.temps;
    let r = stepTemps(s, temps(46, 40), limits);
    expect(r.events).toEqual([{ type: 'temp_high', which: 'battery', tempC: 46, limitC: 45 }]);
    s = r.state;
    r = stepTemps(s, temps(47, 40), limits);
    expect(r.events).toEqual([]);
    r = stepTemps(r.state, temps(42, 40), limits); // within hysteresis
    expect(r.events).toEqual([]);
    r = stepTemps(r.state, temps(40, 40), limits);
    expect(r.events).toEqual([{ type: 'temp_ok', which: 'battery', tempC: 40, limitC: 45 }]);
  });

  it('ignores missing values and watches the inverter separately', () => {
    const r = stepTemps(initialWatch.temps, temps(null, 71), limits);
    expect(r.events).toEqual([{ type: 'temp_high', which: 'inverter', tempC: 71, limitC: 70 }]);
  });
});

describe('nightShortfall', () => {
  const cfg = { capacityKwh: 23.552, reservePct: 10, timezone: Z };
  it('warns at night when the battery runs out before 07:00', () => {
    // 34% → 24% usable ≈ 5.65 kWh at 1.4 kW ≈ 4 h → ends ≈ 03:02
    const w = nightShortfall(34, 1400, at('2026-11-04T23:00'), cfg);
    expect(w).not.toBeNull();
    expect(DateTime.fromMillis(w!.endsAt, { zone: Z }).toFormat('HH:mm')).toBe('03:02');
    expect(w!.morningKey).toBe('2026-11-05');
    expect(Math.round(w!.needW)).toBe(707); // 5.65 kWh over 8 h
  });

  it('stays quiet when enough, or during the day', () => {
    expect(nightShortfall(90, 600, at('2026-11-04T23:00'), cfg)).toBeNull();
    expect(nightShortfall(20, 1400, at('2026-11-04T12:00'), cfg)).toBeNull();
  });

  it('after midnight targets the same morning', () => {
    expect(nightShortfall(15, 1000, at('2026-11-05T02:00'), cfg)?.morningKey).toBe('2026-11-05');
  });
});

describe('diffAlerts', () => {
  const a = (id: string, endTs: number | null): DeyeAlert => ({ id, code: 'F13', name: 'Grid fault', level: null, startTs: 1000, endTs });
  it('reports new active alerts and their end once', () => {
    let r = diffAlerts({}, [a('1', null)], false);
    expect(r.events.map((e) => e.type)).toEqual(['alert_new']);
    r = diffAlerts(r.known, [a('1', null)], false);
    expect(r.events).toEqual([]);
    r = diffAlerts(r.known, [a('1', 5000)], false);
    expect(r.events.map((e) => e.type)).toEqual(['alert_end']);
    r = diffAlerts(r.known, [a('1', 5000)], false);
    expect(r.events).toEqual([]);
  });

  it('a new alert that already ended is reported as a short one', () => {
    const r = diffAlerts({}, [a('2', 5000)], false);
    expect(r.events.map((e) => e.type)).toEqual(['alert_new']);
    expect(r.known['2']).toEqual({ active: false, seenAt: expect.any(Number) });
  });

  it('first run only remembers history, still reports active ones', () => {
    const r = diffAlerts({}, [a('1', 5000), a('2', null)], true);
    expect(r.events.map((e) => [e.type, e.alert.id])).toEqual([['alert_new', '2']]);
  });
});

describe('shouldWarnShort', () => {
  const M = 60_000;
  it('warns once per target and again only if the scheduled power-on moved 30 min later', () => {
    expect(shouldWarnShort(null, 'sched@1000000')).toBe(true);
    expect(shouldWarnShort('sched@1000000', 'sched@1000000')).toBe(false);
    expect(shouldWarnShort('sched@1000000', `sched@${1000000 + 20 * M}`)).toBe(false);
    expect(shouldWarnShort('sched@1000000', `sched@${1000000 + 30 * M}`)).toBe(true);
    expect(shouldWarnShort('2026-11-05', '2026-11-05')).toBe(false);
    expect(shouldWarnShort('sched@1000000', '2026-11-05')).toBe(true);
  });
});
