import { describe, expect, it } from 'vitest';
import { batteryLimitW, batteryZone, gridLoad, gridWatchStep, loadZone, stepGridLoad } from '../src/domain/load.js';

describe('gridLoad', () => {
  it('splits grid draw into house and batteries', () => {
    expect(gridLoad({ gridPowerW: 7000, batteryPowerW: 4100 })).toEqual({ totalW: 7000, homeW: 2900, batteryW: 4100 });
  });

  it('caps the battery share at the grid draw when the sun covers part of the charge', () => {
    expect(gridLoad({ gridPowerW: 3000, batteryPowerW: 4100 })).toEqual({ totalW: 3000, homeW: 0, batteryW: 3000 });
  });

  it('gives everything to the house while discharging', () => {
    expect(gridLoad({ gridPowerW: 2000, batteryPowerW: -500 })).toEqual({ totalW: 2000, homeW: 2000, batteryW: 0 });
  });

  it('shows nothing on export, near-zero draw or missing data', () => {
    expect(gridLoad({ gridPowerW: -300, batteryPowerW: 0 })).toBeNull();
    expect(gridLoad({ gridPowerW: 20, batteryPowerW: 0 })).toBeNull();
    expect(gridLoad({ gridPowerW: null, batteryPowerW: 100 })).toBeNull();
  });
});

describe('loadZone', () => {
  it('colors by fixed bands with red from the threshold', () => {
    expect([3999, 4000, 5499, 5500, 6999, 7000].map((w) => loadZone(w, 7000))).toEqual(['green', 'yellow', 'yellow', 'orange', 'orange', 'red']);
  });

  it('lets a low threshold override the bands', () => {
    expect(loadZone(5200, 5000)).toBe('red');
  });

  it('is red over the breaker even with a threshold above it', () => {
    expect(loadZone(8500, 9000)).toBe('red');
  });
});

describe('stepGridLoad', () => {
  it('fires once at the threshold', () => {
    expect(stepGridLoad(false, 7000, 7000)).toEqual({ high: true, event: 'high' });
    expect(stepGridLoad(false, 6900, 7000)).toEqual({ high: false, event: null });
  });

  it('clears only below threshold minus 0.5 kW', () => {
    expect(stepGridLoad(true, 6600, 7000)).toEqual({ high: true, event: null });
    expect(stepGridLoad(true, 6499, 7000)).toEqual({ high: false, event: 'ok' });
  });
});

describe('gridWatchStep', () => {
  it('silently resets during an outage so the next overload after it alerts again', () => {
    expect(gridWatchStep(true, 'off', 0, 7000)).toEqual({ high: false, event: null });
    expect(gridWatchStep(false, 'on', 7500, 7000)).toEqual({ high: true, event: 'high' });
  });

  it('keeps the state when there is no grid data', () => {
    expect(gridWatchStep(true, 'on', null, 7000)).toEqual({ high: true, event: null });
    expect(gridWatchStep(true, null, 1000, 7000)).toEqual({ high: false, event: 'ok' });
  });

  it('treats export as zero draw', () => {
    expect(gridWatchStep(true, 'on', -300, 7000)).toEqual({ high: false, event: 'ok' });
  });
});

describe('battery mode', () => {
  it('limit is the smaller of discharge current × voltage and the inverter rating', () => {
    expect(batteryLimitW(180, 54.3, 10_000)).toBe(9774);
    expect(batteryLimitW(180, 57, 10_000)).toBe(10_000);
    expect(batteryLimitW(null, 54.3, 10_000)).toBe(10_000);
    expect(batteryLimitW(180, 54.3, null)).toBe(9774);
    expect(batteryLimitW(null, 54.3, null)).toBeNull();
    expect(batteryLimitW(null, 54.3, 0)).toBeNull(); // a zero rating means unknown
    expect(batteryLimitW(0, 54.3, 0)).toBeNull();
  });

  it('zones by share of the limit: 50 / 70 / 90 %', () => {
    expect([4999, 5000, 6999, 7000, 8999, 9000].map((w) => batteryZone(w, 10_000))).toEqual(['green', 'yellow', 'yellow', 'orange', 'orange', 'red']);
  });
});
