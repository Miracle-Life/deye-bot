import { describe, expect, it } from 'vitest';
import { batteryV, batteryAlertGate, batteryBands, batteryWatchStep, batteryScaleW, batteryZone, gridChargeW, gridLoad, gridScaleW, gridWatchStep, loadZone, stepGridLoad } from '../src/domain/load.js';

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
  it('yellow from 5 kW, orange from 6.5 kW, red from the threshold', () => {
    expect(loadZone(5200, 8000)).toBe('yellow');
    expect(loadZone(6600, 8000)).toBe('orange');
    expect(loadZone(8000, 8000)).toBe('red');
    expect([4999, 5000, 6499, 6500, 7999].map((w) => loadZone(w, 8000))).toEqual(['green', 'yellow', 'yellow', 'orange', 'orange']);
  });

  it('lets a low threshold override the bands', () => {
    expect(loadZone(5200, 5000)).toBe('red');
  });
});

describe('gridScaleW', () => {
  it('is the inverter rating, 10 kW when unknown', () => {
    expect(gridScaleW(null)).toBe(10_000);
    expect(gridScaleW(0)).toBe(10_000);
    expect(gridScaleW(12_000)).toBe(12_000);
  });

  it('grid charge power = configured current × battery voltage', () => {
    expect(gridChargeW(80, 54.84)).toBe(4387);
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
  it('scale: discharge current × voltage × 0.89, capped by the rating', () => {
    expect(batteryScaleW(180, 53.1, 10_000)).toBe(8507);
    expect(batteryScaleW(180, 50, 10_000)).toBe(8010);
    expect(batteryScaleW(null, 53, 10_000)).toBe(10_000);
    expect(batteryScaleW(180, 53, null)).toBe(8491);
    expect(batteryScaleW(0, 53, null)).toBe(10_000);
    expect(batteryScaleW(250, 57, 10_000)).toBe(10_000);
  });

  it('zones: yellow from half the scale, orange from 70 %, red from the threshold', () => {
    expect(batteryZone(7000, 8500, 7000)).toBe('red');
    expect(batteryZone(4300, 8500, 7000)).toBe('yellow');
    expect(batteryZone(6000, 8500, 7000)).toBe('orange');
    expect(batteryZone(4000, 8500, 7000)).toBe('green');
  });

  it('threshold above scale: red from the scale end', () => {
    expect(batteryZone(7900, 7900, 8000)).toBe('red');
    expect(batteryBands(7900, 8000).red).toBe(1);
    expect(batteryBands(8500, 7000)).toEqual({ yellow: 0.5, orange: 0.7, red: 7000 / 8500 });
  });
});

describe('batteryWatchStep', () => {
  it('fires at the threshold during an outage, clears 0.5 kW lower', () => {
    expect(batteryWatchStep(false, 'off', 7000, 7000)).toEqual({ high: true, event: 'high' });
    expect(batteryWatchStep(true, 'off', 6600, 7000)).toEqual({ high: true, event: null });
    expect(batteryWatchStep(true, 'off', 6400, 7000)).toEqual({ high: false, event: 'ok' });
  });

  it('silently resets when the grid is back; keeps state without data', () => {
    expect(batteryWatchStep(true, 'on', 9000, 7000)).toEqual({ high: false, event: null });
    expect(batteryWatchStep(true, null, 1000, 7000)).toEqual({ high: true, event: null });
    expect(batteryWatchStep(true, 'off', null, 7000)).toEqual({ high: true, event: null });
  });
});

describe('batteryAlertGate', () => {
  const MIN = 60_000;
  const quiet = { alertedAt: null, alerted: false };
  it('first overload alerts; a repeat within 15 min stays silent, and so does its all-clear', () => {
    const a = batteryAlertGate(quiet, 'high', 0);
    expect(a).toEqual({ send: true, state: { alertedAt: 0, alerted: true } });
    const ok = batteryAlertGate(a.state, 'ok', 2 * MIN);
    expect(ok.send).toBe(true);
    const again = batteryAlertGate(ok.state, 'high', 5 * MIN);
    expect(again.send).toBe(false);
    expect(batteryAlertGate(again.state, 'ok', 6 * MIN).send).toBe(false);
  });

  it('alerts again after the cooldown', () => {
    expect(batteryAlertGate({ alertedAt: 0, alerted: false }, 'high', 15 * MIN).send).toBe(true);
  });
});

describe('batteryV', () => {
  it('a reported 0 V or missing voltage falls back to the nominal 51.2 V', () => {
    expect(batteryV(0)).toBe(51.2);
    expect(batteryV(null)).toBe(51.2);
    expect(batteryV(-1)).toBe(51.2);
    expect(batteryV(53.1)).toBe(53.1);
  });
});
