import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { dayCost, monthSummary, splitDay, summarizeFrames, type EnergyDay } from '../src/domain/energy.js';
import { freshToday } from '../src/energy.js';

const Z = 'Europe/Kyiv';
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();
const yasno = { dayPrice: 4.32, nightPrice: 2.16, nightFrom: 23, nightTo: 7 };
const f = (t: string, purchased: number) => ({ ts: at(`2026-11-03T${t}`), purchased, consumption: purchased + 1, charge: 0.5, discharge: 0.2, pv: 0 });

describe('splitDay', () => {
  const frames = [f('00:30', 0.5), f('06:59', 3.0), f('07:05', 3.1), f('22:58', 9.0), f('23:30', 9.4), f('23:58', 10.0)];

  it('splits grid purchase into night (before 07:00 and after 23:00) and day', () => {
    const d = splitDay(summarizeFrames(frames, '2026-11-03', Z), yasno);
    expect(d).toEqual({ date: '2026-11-03', dayKwh: 6, nightKwh: 4, consumption: 11, charge: 0.5, discharge: 0.2, pv: 0 });
    expect(dayCost(d, yasno)).toBeCloseTo(6 * 4.32 + 4 * 2.16, 6);
  });

  it('single-zone tariff counts everything as day', () => {
    const d = splitDay(summarizeFrames(frames, '2026-11-03', Z), { ...yasno, nightPrice: null });
    expect([d.dayKwh, d.nightKwh]).toEqual([10, 0]);
  });

  it('a counter glitch to zero mid-day does not go negative', () => {
    const d = splitDay(summarizeFrames([f('06:00', 2), f('12:00', 0), f('22:50', 7), f('23:50', 8)], '2026-11-03', Z), yasno);
    expect(d.nightKwh).toBe(3);
    expect(d.dayKwh).toBe(5);
  });

  it("ignores yesterday's total carried into the first minutes after midnight", () => {
    const frames = [f('00:01', 31.4), f('00:04', 0.2), f('06:58', 6.0), f('22:59', 11.0), f('23:58', 12.0)];
    const d = splitDay(summarizeFrames(frames, '2026-11-03', Z), yasno);
    expect([d.nightKwh, d.dayKwh]).toEqual([7, 5]); // without the fix: night 31.4, day 0
    expect(d.consumption).toBe(13);
  });

  it('night hours can change later: the split is recomputed from hourly counters', () => {
    const raw = summarizeFrames(frames, '2026-11-03', Z);
    expect(splitDay(raw, { ...yasno, nightFrom: 22, nightTo: 6 })).toMatchObject({ nightKwh: 0.5 + (10 - 3.1), dayKwh: 2.6 });
  });

  it('no frames means zero', () => {
    expect(splitDay(summarizeFrames([], '2026-11-03', Z), yasno)).toMatchObject({ dayKwh: 0, nightKwh: 0, consumption: 0 });
  });
});

describe('monthSummary', () => {
  const day = (date: string, dayKwh: number, nightKwh: number): EnergyDay => ({ date, dayKwh, nightKwh, consumption: dayKwh + nightKwh, charge: 0, discharge: 0, pv: 0 });

  it('totals, savings from the night rate and a month forecast', () => {
    const s = monthSummary([day('2026-11-01', 10, 5), day('2026-11-02', 10, 5)], yasno, '2026-11', at('2026-11-03T00:00'), Z, null);
    expect(s.cost).toBeCloseTo(2 * (43.2 + 10.8), 6);
    expect(s.savedByNight).toBeCloseTo(10 * 2.16, 6);
    expect(s.forecast).toBeCloseTo(54 * 30, 6); // 2 full days elapsed, 30-day month
    expect(s.perDay.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('a past month has no forecast; data start shortens the elapsed span', () => {
    expect(monthSummary([day('2026-10-31', 1, 1)], yasno, '2026-10', at('2026-11-03T00:00'), Z, null).forecast).toBeNull();
    const s = monthSummary([day('2026-11-02', 10, 5)], yasno, '2026-11', at('2026-11-03T00:00'), Z, at('2026-11-02T00:00'));
    expect(s.forecast).toBeCloseTo(54 * 30, 6);
  });
});

describe('freshToday', () => {
  const day = { date: '2026-10-31', purchasedAtHour: [], consumption: 20, charge: 0, discharge: 0, pv: 0 };
  it('uses the cached day only for the same date and while fresh', () => {
    expect(freshToday({ at: 1_000, day }, '2026-10-31', 2_000)).toBe(true);
    expect(freshToday({ at: 1_000, day }, '2026-11-01', 2_000)).toBe(false); // just after midnight
    expect(freshToday({ at: 1_000, day }, '2026-10-31', 1_000 + 11 * 60_000)).toBe(false);
    expect(freshToday(null, '2026-10-31', 2_000)).toBe(false);
  });
});
