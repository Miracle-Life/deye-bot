import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { Schedule } from '../src/schedule/model.js';
import { batteryVerdict, dueReminders, isStale, powerOnTarget, refreshAllowed, publishedOutages, socAt, tileState } from '../src/schedule/logic.js';

const Z = 'Europe/Kyiv';
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();
const H = 3_600_000;
const T = '2026-11-04';
const N = '2026-11-05';
const span = (date: string, [a, b]: [number, number]) => ({ start: at(`${date}T00:00`) + a * H, end: at(`${date}T00:00`) + b * H });

/** today/tomorrow outage hours; 'waiting' = not published; 'emergency' = emergency status. */
function sched(today: [number, number][] | 'waiting' | 'emergency', tomorrow: [number, number][] | 'waiting' = 'waiting'): Schedule {
  const day = (date: string, d: typeof today) =>
    d === 'waiting' || d === 'emergency' ? { date, status: d, outages: [] } : { date, status: 'applies' as const, outages: d.map((x) => span(date, x)) };
  return { group: '52.1', days: [day(T, today), day(N, tomorrow)], updatedAt: null, fetchedAt: 0, unknownTypes: [] };
}

describe('publishedOutages', () => {
  it('merges an outage that continues past midnight', () => {
    expect(publishedOutages(sched([[10, 20], [22, 24]], [[0, 6], [14, 18]]))).toEqual([span(T, [10, 20]), { start: at(`${T}T22:00`), end: at(`${N}T06:00`) }, span(N, [14, 18])]);
  });

  it('ignores days that are not published', () => {
    expect(publishedOutages(sched([[22, 24]], 'waiting'))).toEqual([span(T, [22, 24])]);
  });
});

describe('tileState', () => {
  it('off, covered: power-on time merged across midnight', () => {
    const s = tileState(sched([[10, 20], [22, 24]], [[0, 6]]), 'off', at(`${T}T22:40`));
    expect(s).toEqual({ kind: 'off-until', until: at(`${N}T06:00`), endsAtDayEdge: false });
    expect(powerOnTarget(s)).toBe(at(`${N}T06:00`));
  });

  it('off, covered, tomorrow not published yet: 24:00 is no real power-on target', () => {
    const s = tileState(sched([[22, 24]], 'waiting'), 'off', at(`${T}T22:40`));
    expect(s).toEqual({ kind: 'off-until', until: at(`${N}T00:00`), endsAtDayEdge: true });
    expect(powerOnTarget(s)).toBeNull(); // the 07:00 night logic applies instead
  });

  it('off a few minutes before the scheduled start counts as covered', () => {
    expect(tileState(sched([[10, 20]]), 'off', at(`${T}T09:55`))).toMatchObject({ kind: 'off-until', until: at(`${T}T20:00`) });
  });

  it('off well after the scheduled power-on: late', () => {
    const s = tileState(sched([[10, 20]]), 'off', at(`${T}T20:31`), at(`${T}T10:07`));
    expect(s).toEqual({ kind: 'off-late', due: at(`${T}T20:00`) });
    expect(powerOnTarget(s)).toBeNull();
  });

  it('a new outage after the scheduled one ended is unscheduled, not late', () => {
    expect(tileState(sched([[10, 20]]), 'off', at(`${T}T21:00`), at(`${T}T21:00`))).toEqual({ kind: 'off-unscheduled' });
  });

  it('off with no scheduled outage around: unscheduled', () => {
    expect(tileState(sched([[10, 20]]), 'off', at(`${T}T03:00`))).toEqual({ kind: 'off-unscheduled' });
  });

  it('on inside a scheduled outage', () => {
    expect(tileState(sched([[10, 20]]), 'on', at(`${T}T10:05`))).toEqual({ kind: 'on-in-slot', from: at(`${T}T10:00`), until: at(`${T}T20:00`) });
  });

  it('on: next outage, end merged across midnight', () => {
    expect(tileState(sched([[10, 20], [22, 24]], [[0, 6]]), 'on', at(`${T}T20:45`))).toEqual({ kind: 'next', start: at(`${T}T22:00`), end: at(`${N}T06:00`) });
  });

  it('on: next outage tomorrow', () => {
    expect(tileState(sched([[10, 20]], [[14, 18]]), 'on', at(`${T}T21:00`))).toEqual({ kind: 'next', start: at(`${N}T14:00`), end: at(`${N}T18:00`) });
  });

  it('on: nothing more today and tomorrow unpublished → preliminary none', () => {
    expect(tileState(sched([[10, 20]], 'waiting'), 'on', at(`${T}T21:00`))).toEqual({ kind: 'none-today', preliminary: true });
    expect(tileState(sched([], []), 'on', at(`${T}T09:00`))).toEqual({ kind: 'none-today', preliminary: true });
  });

  it('emergency and unpublished today', () => {
    expect(tileState(sched('emergency'), 'off', at(`${T}T12:00`))).toEqual({ kind: 'emergency' });
    expect(tileState(sched('waiting'), 'off', at(`${T}T00:05`))).toEqual({ kind: 'today-unpublished' });
    expect(tileState(sched('waiting'), 'on', at(`${T}T06:00`))).toEqual({ kind: 'today-unpublished' });
  });

  it('no grid state → nothing', () => {
    expect(tileState(sched([[10, 20]]), null, at(`${T}T12:00`))).toBeNull();
  });
});

describe('batteryVerdict', () => {
  const o = { capacityKwh: 20, reservePct: 10 };
  it('not enough: when it runs out and what load would last', () => {
    const v = batteryVerdict(30, 1200, 0, at(`${T}T21:00`), at(`${N}T06:00`), o);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.adviseLoadW).toBe(440); // 4 kWh / 9 h = 444 W
    expect(v.endsAt).toBe(at(`${T}T21:00`) + (4000 / 1200) * H);
  });

  it('solar adds to the allowed house load', () => {
    const v = batteryVerdict(30, 1200, 300, at(`${T}T21:00`), at(`${N}T06:00`), o);
    expect(!v.ok && v.adviseLoadW).toBe(740);
  });

  it('enough charge', () => {
    expect(batteryVerdict(90, 500, 0, at(`${T}T21:00`), at(`${N}T06:00`), o)).toEqual({ ok: true });
  });
});

describe('socAt', () => {
  it('projects the charge and caps at 100', () => {
    expect(socAt(80, 4000, 20, 0, H)).toBe(100);
    expect(socAt(50, 2000, 20, 0, H)).toBe(60);
  });
});

describe('dueReminders', () => {
  const s = sched([[10, 20], [22, 24]], [[0, 6]]);
  const MIN = 60_000;
  it('fires within the lead time before the event, once', () => {
    const r = dueReminders(s, 'on', at(`${T}T21:30`), 30, 'off', new Set());
    expect(r).toEqual([{ kind: 'off', at: at(`${T}T22:00`), key: `off@${at(`${T}T22:00`)}` }]);
    expect(dueReminders(s, 'on', at(`${T}T21:31`), 30, 'off', new Set([r[0]!.key]))).toEqual([]);
  });

  it('not before the lead time and not after the event', () => {
    expect(dueReminders(s, 'on', at(`${T}T21:29`), 30, 'off', new Set())).toEqual([]);
    expect(dueReminders(s, 'on', at(`${T}T22:00`), 30, 'off', new Set())).toEqual([]);
  });

  it('power-on reminder uses the merged end across midnight', () => {
    expect(dueReminders(s, 'off', at(`${N}T05:40`), 30, 'on', new Set()).map((x) => x.at)).toEqual([at(`${N}T06:00`)]);
    expect(dueReminders(s, 'off', at(`${T}T23:40`), 30, 'on', new Set())).toEqual([]); // 24:00 is not a power-on
  });

  it('skipped when the grid is already in that state or reminders are off', () => {
    expect(dueReminders(s, 'off', at(`${T}T21:45`), 30, 'off', new Set())).toEqual([]);
    expect(dueReminders(s, 'on', at(`${N}T05:45`), 30, 'on', new Set())).toEqual([]);
    expect(dueReminders(s, 'on', at(`${T}T21:45`), 0, 'off', new Set())).toEqual([]);
  });

  it('a moved event gets its own reminder', () => {
    const sent = new Set([`off@${at(`${T}T22:00`)}`]);
    const moved = sched([[10, 20], [22.5, 24]], [[0, 6]]);
    expect(dueReminders(moved, 'on', at(`${T}T22:05`), 30, 'off', sent).map((x) => x.at)).toEqual([at(`${T}T22:00`) + 30 * MIN]);
  });
});

describe('freshness', () => {
  it('stale after 2 h', () => {
    const s = { ...sched([[10, 20]]), fetchedAt: 0 };
    expect(isStale(s, 2 * H)).toBe(false);
    expect(isStale(s, 2 * H + 1000)).toBe(true);
  });

  it('manual refresh at most once a minute', () => {
    expect(refreshAllowed(null, 0)).toBe(true);
    expect(refreshAllowed(0, 59_000)).toBe(false);
    expect(refreshAllowed(0, 60_000)).toBe(true);
  });
});
