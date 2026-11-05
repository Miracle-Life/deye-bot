import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { emptyReading } from '../src/deye/types.js';
import { buildTimeline, dayRange, dischargedKwh, hourStrip, minSoc, monthRange, summarize, weekRange } from '../src/domain/stats.js';

const Z = 'Europe/Kyiv';
const H = 3_600_000;
const MIN = 60_000;
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();
const FAR = at('2030-01-01T00:00');

describe('stats', () => {
  it('day with three outages', () => {
    const { from, to } = dayRange('2026-11-03', Z);
    const outages = [
      { start: at('2026-11-03T04:17'), end: at('2026-11-03T07:35') },
      { start: at('2026-11-03T13:00'), end: at('2026-11-03T15:10') },
      { start: at('2026-11-03T21:48'), end: at('2026-11-03T22:40') },
    ];
    const segs = buildTimeline(from, to, outages, [], FAR);
    const sum = summarize(segs, outages, from, to);
    expect(sum.offMs).toBe(6 * H + 20 * MIN);
    expect(sum.onMs).toBe(17 * H + 40 * MIN);
    expect(sum.unknownMs).toBe(0);
    expect(sum.outageCount).toBe(3);
    expect(sum.longestOutage).toEqual({ start: at('2026-11-03T04:17'), ms: 3 * H + 18 * MIN });
    expect(hourStrip(from, to, segs)).toBe('🟩🟩🟩🟩🟥🟥🟥🟥🟩🟩🟩🟩🟩🟥🟥🟩🟩🟩🟩🟩🟩🟩🟥🟩');
  });

  it('outage across midnight splits', () => {
    const outages = [{ start: at('2026-11-03T22:00'), end: at('2026-11-04T02:00') }];
    const d1 = dayRange('2026-11-03', Z);
    const d2 = dayRange('2026-11-04', Z);
    const s1 = summarize(buildTimeline(d1.from, d1.to, outages, [], FAR), outages, d1.from, d1.to);
    const s2 = summarize(buildTimeline(d2.from, d2.to, outages, [], FAR), outages, d2.from, d2.to);
    expect(s1.offMs).toBe(2 * H);
    expect(s2.offMs).toBe(2 * H);
    expect(s1.outageCount).toBe(1);
    expect(s2.outageCount).toBe(1);
  });

  it('DST day sums to 25h', () => {
    const { from, to } = dayRange('2026-10-25', Z);
    expect(to - from).toBe(25 * H);
    const segs = buildTimeline(from, to, [], [], FAR);
    const sum = summarize(segs, [], from, to);
    expect(sum.onMs + sum.offMs + sum.unknownMs).toBe(25 * H);
    expect([...hourStrip(from, to, segs)].length).toBe(25);
  });

  it('gap becomes unknown, overrides outage', () => {
    const { from, to } = dayRange('2026-11-03', Z);
    const outages = [{ start: at('2026-11-03T10:00'), end: at('2026-11-03T12:00') }];
    const gaps = [{ start: at('2026-11-03T11:00'), end: at('2026-11-03T13:00') }];
    const sum = summarize(buildTimeline(from, to, outages, gaps, FAR), outages, from, to);
    expect(sum.offMs).toBe(1 * H);
    expect(sum.unknownMs).toBe(2 * H);
  });

  it('open outage runs until now', () => {
    const { from, to } = dayRange('2026-11-03', Z);
    const outages = [{ start: at('2026-11-03T10:00'), end: null }];
    const sum = summarize(buildTimeline(from, to, outages, [], at('2026-11-03T12:00')), outages, from, to);
    expect(sum.offMs).toBe(2 * H);
  });

  it('today counted up to now', () => {
    const { from, to } = dayRange('2026-11-03', Z);
    const sum = summarize(buildTimeline(from, to, [], [], at('2026-11-03T12:00')), [], from, to);
    expect(sum.onMs + sum.offMs + sum.unknownMs).toBe(12 * H);
  });

  it('weekRange is Mon–Sun', () => {
    const w = weekRange('2026-11-04', Z);
    expect(w.from).toBe(at('2026-11-02T00:00'));
    expect(w.to).toBe(at('2026-11-09T00:00'));
  });

  it('monthRange is calendar month', () => {
    const m = monthRange('2026-11-04', Z);
    expect(m.from).toBe(at('2026-11-01T00:00'));
    expect(m.to).toBe(at('2026-12-01T00:00'));
  });

  it('dischargedKwh integrates discharge and skips gaps', () => {
    const r = (t: number, w: number) => ({ ...emptyReading(t), batteryPowerW: w });
    const hour = [0, 1, 2, 3, 4, 5, 6].map((i) => r(i * 10 * MIN, -1000));
    expect(dischargedKwh(hour, 15 * MIN)).toBeCloseTo(1.0, 5);
    expect(dischargedKwh([r(0, -1000), r(20 * MIN, -1000)], 15 * MIN)).toBe(0);
    expect(dischargedKwh([r(0, 500), r(10 * MIN, 500)], 15 * MIN)).toBe(0);
  });

  it('minSoc finds lowest', () => {
    const r = (t: number, soc: number | null) => ({ ...emptyReading(t), soc });
    expect(minSoc([r(1, 50), r(2, 41), r(3, null), r(4, 60)])).toEqual({ soc: 41, ts: 2 });
    expect(minSoc([])).toBeNull();
  });
});
