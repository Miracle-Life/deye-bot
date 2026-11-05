import { describe, expect, it } from 'vitest';
import { dropFutureLastTs, fromFuture, initialState, missedWhileDown, stepReading, stepWithGap, stepTick, type DetectorConfig, type DetectorState } from '../src/domain/detector.js';
import { emptyReading } from '../src/deye/types.js';

const MIN = 60_000;
const cfg: DetectorConfig = { offV: 50, okV: 180, staleMs: 15 * MIN, thresholds: [50, 30, 20, 10] };
const ON = [230, 230, 230];
const OFF = [0, 0, 0];
const rd = (tMin: number, volts: number[], soc = 80, battW = 0) => ({
  ...emptyReading(tMin * MIN),
  gridVoltages: volts,
  soc,
  batteryPowerW: battW,
});

function run(readings: ReturnType<typeof rd>[], s: DetectorState = initialState) {
  const events = [];
  for (const r of readings) {
    const res = stepReading(s, r, cfg);
    s = res.state;
    events.push(...res.events);
  }
  return { state: s, events };
}

describe('detector', () => {
  it('first reading sets state silently', () => {
    expect(run([rd(0, ON)]).events).toEqual([]);
  });

  it('on→off clear emits outage_started at reading ts', () => {
    const { events } = run([rd(0, ON), rd(5, OFF)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'outage_started', ts: 5 * MIN, approxFromTs: null, missingPhases: ['L1', 'L2', 'L3'] });
  });

  it('ambiguous change waits for confirmation', () => {
    const first = run([rd(0, ON), rd(5, [230, 30, 120])]);
    expect(first.events).toEqual([]);
    const second = run([rd(10, [230, 0, 230])], first.state);
    expect(second.events[0]).toMatchObject({ type: 'outage_started', ts: 5 * MIN });
  });

  it('ignores duplicate reading timestamp', () => {
    const { events } = run([rd(0, ON), rd(5, [230, 30, 120]), rd(5, [230, 30, 120])]);
    expect(events).toEqual([]);
  });

  it('off→on emits outage_ended with startTs', () => {
    const { events } = run([rd(0, ON), rd(5, OFF), rd(10, OFF), rd(20, ON)]);
    expect(events[1]).toMatchObject({ type: 'outage_ended', ts: 20 * MIN, startTs: 5 * MIN, approxFromTs: null });
  });

  it('change across gap has approxFromTs', () => {
    const { events } = run([rd(0, ON), rd(20, OFF)]);
    expect(events[0]).toMatchObject({ type: 'outage_started', approxFromTs: 0 });
  });

  it('battery_low emits once per threshold, lowest only', () => {
    const { state, events } = run([rd(0, ON, 60), rd(5, OFF, 55)]);
    expect(events.map((e) => e.type)).toEqual(['outage_started']);
    const a = run([rd(10, OFF, 45)], state);
    expect(a.events).toMatchObject([{ type: 'battery_low', threshold: 50 }]);
    const b = run([rd(15, OFF, 25)], a.state);
    expect(b.events).toMatchObject([{ type: 'battery_low', threshold: 30 }]);
    const c = run([rd(20, OFF, 24)], b.state);
    expect(c.events).toEqual([]);
  });

  it('a threshold added mid-outage above the current charge does not fire', () => {
    const { state } = run([rd(0, ON, 60), rd(5, OFF, 45)]);
    const res = stepReading(state, rd(10, OFF, 44), { ...cfg, thresholds: [60, 50, 30, 20, 10] });
    expect(res.events).toEqual([]);
    // but it still fires normally when the charge actually crosses one
    const next = stepReading(res.state, rd(15, OFF, 29), { ...cfg, thresholds: [60, 50, 30, 20, 10] });
    expect(next.events).toMatchObject([{ type: 'battery_low', threshold: 30 }]);
  });

  it('battery_low only during outage', () => {
    expect(run([rd(0, ON, 40), rd(5, ON, 25)]).events).toEqual([]);
  });

  it('battery_full once per cycle', () => {
    const a = run([rd(0, ON, 99, 500), rd(5, ON, 100, 0)]);
    expect(a.events).toMatchObject([{ type: 'battery_full' }]);
    const b = run([rd(10, ON, 100, 0)], a.state);
    expect(b.events).toEqual([]);
    const c = run([rd(15, ON, 90, 800), rd(20, ON, 100, 0)], b.state);
    expect(c.events).toMatchObject([{ type: 'battery_full', chargeStartTs: 15 * MIN }]);
  });

  it('stepTick emits data_stale once, then data_resumed', () => {
    const { state } = run([rd(0, ON)]);
    const t1 = stepTick(state, 16 * MIN, cfg);
    expect(t1.events).toEqual([{ type: 'data_stale', sinceTs: 0 }]);
    const t2 = stepTick(t1.state, 17 * MIN, cfg);
    expect(t2.events).toEqual([]);
    const r = stepReading(t2.state, rd(30, ON), cfg);
    expect(r.events).toEqual([{ type: 'data_resumed', ts: 30 * MIN, gapFromTs: 0 }]);
  });

  it('restores state without re-emitting outage_started', () => {
    const { state } = run([rd(0, ON), rd(5, OFF)]);
    const restored = JSON.parse(JSON.stringify(state)) as DetectorState;
    expect(run([rd(10, OFF)], restored).events).toEqual([]);
  });

  it('first reading while off opens approximate outage', () => {
    const { state } = run([rd(0, OFF)]);
    expect(state.outage).toMatchObject({ startTs: 0, startApprox: true });
  });
});

describe('missedWhileDown', () => {
  const H = 60 * MIN;
  const now = 10 * H;
  const started = { type: 'outage_started' as const, ts: now - 30 * MIN, approxFromTs: null, missingPhases: [], reading: rd(0, OFF) };
  const ended = { type: 'outage_ended' as const, ts: now - 5 * MIN, approxFromTs: null, startTs: now - 30 * MIN, reading: rd(0, ON) };
  const low = { type: 'battery_low' as const, ts: now - 10 * MIN, threshold: 50, outageStartTs: now - 30 * MIN, reading: rd(0, OFF) };

  it('announces grid changes that happened while the bot was down', () => {
    expect(missedWhileDown([started, low, ended], now - H, now).map((e) => e.type)).toEqual(['outage_started', 'outage_ended']);
  });

  it('stays silent on first start and for old history', () => {
    expect(missedWhileDown([started], null, now)).toEqual([]);
    expect(missedWhileDown([{ ...started, ts: now - 7 * H }], now - 8 * H, now)).toEqual([]);
  });
});

describe('clock sanity', () => {
  it('flags readings stamped more than 10 min ahead', () => {
    expect(fromFuture(1_000_000 + 11 * 60_000, 1_000_000)).toBe(true);
    expect(fromFuture(1_000_000 + 9 * 60_000, 1_000_000)).toBe(false);
  });

  it('forgets a saved position that lies in the future', () => {
    const s = { ...initialState, lastTs: 5_000_000_000_000 };
    expect(dropFutureLastTs(s, 1_000_000).lastTs).toBeNull();
    expect(dropFutureLastTs({ ...initialState, lastTs: 900_000 }, 1_000_000).lastTs).toBe(900_000);
  });
});

describe('stepWithGap', () => {
  it('marks a silence longer than staleMs as a gap even without a tick in between', () => {
    const s = run([rd(0, ON)]).state;
    const r = stepWithGap(s, rd(120, ON), cfg);
    expect(r.events.map((e) => e.type)).toEqual(['data_stale', 'data_resumed']);
    expect(r.state.stale).toBe(false);
  });

  it('adds nothing for a normal next frame', () => {
    const s = run([rd(0, ON)]).state;
    expect(stepWithGap(s, rd(3, ON), cfg).events).toEqual([]);
  });
});

describe('battery_full after an outage', () => {
  it('is not sent when the battery never dropped below 100', () => {
    const { events } = run([rd(0, ON, 100), rd(3, OFF, 100), rd(6, OFF, 100), rd(9, ON, 100), rd(12, ON, 100)]);
    expect(events.map((e) => e.type)).toEqual(['outage_started', 'outage_ended']);
  });

  it('is still sent once the battery recharges to 100 after an outage', () => {
    const { events } = run([rd(0, ON, 100), rd(3, OFF, 90, -500), rd(6, OFF, 85, -500), rd(9, ON, 85, 3000), rd(12, ON, 100, 100)]);
    expect(events.map((e) => e.type)).toEqual(['outage_started', 'outage_ended', 'battery_full']);
  });
});
