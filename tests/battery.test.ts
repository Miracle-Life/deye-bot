import { describe, expect, it } from 'vitest';
import { emptyReading } from '../src/deye/types.js';
import { aggregateDay, capacitySummary, findCapacityRuns, lifetimeDischargeKwh, mergeRuns, wear } from '../src/domain/battery.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOMINAL = 23.55;
const rd = (tMin: number, soc: number | null, battW: number) => ({ ...emptyReading(tMin * MIN), soc, batteryPowerW: battW });

/** A steady discharge at `w` watts from soc `from` to `to`, readings every `step` min starting at `t0`. */
function discharge(t0: number, from: number, to: number, w: number, step = 3) {
  const totalMin = (((from - to) / 100) * NOMINAL * 1000 * 60) / w;
  const out = [];
  for (let t = 0; t <= totalMin + 1e-9; t += step) out.push(rd(t0 + t, from - ((from - to) * t) / totalMin, -w));
  const last = out.at(-1)!;
  if (last.soc! > to) out.push(rd(t0 + totalMin, to, -w));
  return out;
}

describe('findCapacityRuns', () => {
  it('estimates the capacity of a steady discharge', () => {
    const runs = findCapacityRuns(discharge(0, 80, 50, 2000));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.socFrom).toBeCloseTo(80);
    expect(runs[0]!.socTo).toBeCloseTo(50);
    expect(runs[0]!.estimateKwh).toBeGreaterThan(NOMINAL * 0.98);
    expect(runs[0]!.estimateKwh).toBeLessThan(NOMINAL * 1.02);
  });

  it('ignores standby draw at 100 % before the real discharge', () => {
    const standby = Array.from({ length: 60 }, (_, i) => rd(i * 3, 100, -30)); // 3 h of -30 W
    const runs = findCapacityRuns([...standby, ...discharge(180, 100, 70, 2000)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.socFrom).toBe(100);
    expect(runs[0]!.estimateKwh).toBeGreaterThan(NOMINAL * 0.98);
    expect(runs[0]!.estimateKwh).toBeLessThan(NOMINAL * 1.02);
  });

  it('a gap longer than 10 min splits the run', () => {
    const a = discharge(0, 80, 68, 2000);
    const b = discharge(a.at(-1)!.ts / MIN + 15, 68, 56, 2000);
    expect(findCapacityRuns([...a, ...b])).toEqual([]);
  });

  it('a drop under 20 points is not used', () => {
    expect(findCapacityRuns(discharge(0, 80, 65, 2000))).toEqual([]);
  });

  it('readings without SOC are skipped, charging ends a run', () => {
    const d = discharge(0, 90, 60, 1500);
    const withHoles = d.flatMap((r, i) => (i === 5 ? [r, rd(r.ts / MIN + 1, null, -1500)] : [r]));
    expect(findCapacityRuns(withHoles)).toHaveLength(1);
    const split = [...discharge(0, 90, 80, 1500), rd(200, 80, 500), ...discharge(203, 80, 70, 1500)];
    expect(findCapacityRuns(split)).toEqual([]);
  });
});

describe('capacitySummary', () => {
  const run = (endDaysAgo: number, estimateKwh: number, now: number) => ({
    startTs: now - endDaysAgo * DAY - 3 * 60 * MIN,
    endTs: now - endDaysAgo * DAY,
    socFrom: 80,
    socTo: 50,
    energyKwh: estimateKwh * 0.3,
    estimateKwh,
  });

  it('median of the last 5 resists an outlier', () => {
    const now = 100 * DAY;
    const runs = [23.0, 23.2, 30.0, 23.1, 22.9].map((e, i) => run(5 - i, e, now));
    const s = capacitySummary(runs, NOMINAL, now);
    expect(s.estimateKwh).toBeCloseTo(23.1);
    expect(s.pct).toBe(98);
  });

  it('trend: last 30 days vs the 30 before, in % of nominal', () => {
    const now = 100 * DAY;
    const runs = [run(40, 23.5, now), run(35, 23.5, now), run(10, 23.0, now), run(5, 23.0, now)];
    expect(capacitySummary(runs, NOMINAL, now).trendPct).toBeCloseTo(-2.1, 1);
  });

  it('no runs → nothing to say', () => {
    expect(capacitySummary([], NOMINAL, 0)).toEqual({ estimateKwh: null, pct: null, trendPct: null });
  });
});

describe('aggregateDay', () => {
  const t = (iso: string) => Date.parse(iso);
  const r = (iso: string, temp: number | null, soc = 80) => ({ ...emptyReading(t(iso)), batteryTempC: temp, soc, dischargeTotalKwh: 40, chargeTotalKwh: 45 });

  it('max/avg temperature and minutes above 35 °C and the limit (step capped at 10 min)', () => {
    const d = aggregateDay(
      '2026-07-01',
      [r('2026-07-01T09:00:00Z', 30), r('2026-07-01T09:03:00Z', 36), r('2026-07-01T09:06:00Z', 46), r('2026-07-01T09:09:00Z', 34), r('2026-07-01T11:00:00Z', 40)],
      45,
    );
    expect(d.maxTempC).toBe(46);
    expect(d.minAbove35).toBe(3 + 3 + 10); // 36 for 3 min, 46 for 3 min, the last 40 counts at most 10
    expect(d.minAboveLimit).toBe(3);
    expect(d.dischargeTotalKwh).toBe(40);
  });

  it('readings without temperature (history backfill) are ignored, not read as 0 °C', () => {
    const d = aggregateDay('2026-07-01', [r('2026-07-01T09:00:00Z', null), r('2026-07-01T09:03:00Z', 30)], 45);
    expect(d.avgTempC).toBe(30);
  });
});

describe('lifetime and wear', () => {
  const day = (dischargeTotalKwh: number | null) => ({ date: 'x', maxTempC: null, avgTempC: null, minAbove35: 0, minAboveLimit: 0, minSoc: null, maxSoc: null, dischargeTotalKwh, chargeTotalKwh: null });

  it('a counter reset does not lose or subtract energy', () => {
    expect(lifetimeDischargeKwh([day(5), day(9), day(2), day(6)], 7)).toBe(5 + 4 + 2 + 4 + 1);
    expect(lifetimeDischargeKwh([], 10.8)).toBe(10.8);
    expect(lifetimeDischargeKwh([day(null), day(3)], null)).toBe(3);
  });

  it('wear by cycles and by capacity', () => {
    expect(wear(48, 6000, 22.8, 23.55)).toEqual({ byCyclesPct: 0.8, byCapacityPct: 3.2 });
    expect(wear(1, 6000, 24, 23.55).byCapacityPct).toBe(0);
    expect(wear(1, 6000, null, 23.55).byCapacityPct).toBeNull();
  });
});

describe('mergeRuns (one discharge seen by several scan windows)', () => {
  const run = (startH: number, endH: number, from: number, to: number) => ({ startTs: startH * 3_600_000, endTs: endH * 3_600_000, socFrom: from, socTo: to, energyKwh: 1, estimateKwh: 23 });
  it('a piece inside a stored run is skipped; a longer version replaces the pieces it contains', () => {
    const full = run(20, 28, 100, 49);
    const piece = run(24, 28, 73, 49);
    expect(mergeRuns([full], [piece])).toEqual({ put: [], remove: [] });
    expect(mergeRuns([piece], [full])).toEqual({ put: [full], remove: [piece.startTs] });
  });

  it('partial overlap keeps the deeper run', () => {
    const a = run(20, 26, 100, 60);
    const b = run(22, 28, 80, 49);
    expect(mergeRuns([a], [b])).toEqual({ put: [], remove: [] }); // a drops 40, b 31
    expect(mergeRuns([b], [a])).toEqual({ put: [a], remove: [b.startTs] });
  });

  it('separate discharges are all kept, duplicates within one batch collapse', () => {
    const a = run(1, 3, 90, 60);
    const b = run(30, 33, 90, 60);
    expect(mergeRuns([a], [b, b])).toEqual({ put: [b], remove: [] });
  });
});

describe('lifetime counter glitches', () => {
  const day = (v: number | null) => ({ date: 'x', maxTempC: null, avgTempC: null, minAbove35: 0, minAboveLimit: 0, minSoc: null, maxSoc: null, dischargeTotalKwh: v, chargeTotalKwh: null });
  it('a small dip or a spike is not a reset; a real reset (to under half) is', () => {
    expect(lifetimeDischargeKwh([day(1000), day(1012), day(1024)], null, 70)).toBe(1024);
    expect(lifetimeDischargeKwh([day(1000), day(999.9), day(1024)], null, 70)).toBe(1024);
    expect(lifetimeDischargeKwh([day(1000), day(65535), day(1024)], null, 70)).toBe(1024);
    expect(lifetimeDischargeKwh([day(1000), day(5), day(17)], null, 70)).toBe(1017);
  });

  it('the day-end counter ignores zeros', () => {
    const t = Date.parse('2026-07-01T09:00:00Z');
    const d = aggregateDay('2026-07-01', [{ ...emptyReading(t), dischargeTotalKwh: 40 }, { ...emptyReading(t + 60_000), dischargeTotalKwh: 0 }], 45);
    expect(d.dischargeTotalKwh).toBe(40);
  });
});
