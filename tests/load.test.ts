import { describe, expect, it } from 'vitest';
import { runtimeColor, batteryV, batteryAlertGate, batteryDrainW, batteriesIdleOnGrid, batteryLoad, runtimeDrainW, batteryBands, batteryWatchStep, batteryScaleW, batteryZone, gridChargeW, gridLoad, gridScaleW, gridWatchStep, loadZone, stepGridLoad } from '../src/domain/load.js';

describe('gridLoad', () => {
  const split = (totalW: number, homeW: number, batteryW: number, inverterW: number, bar = { homeW, batteryW, inverterW }, topped: unknown = null) => ({ totalW, homeW, batteryW, inverterW, bar, topped });

  it('grid = house (as measured) + charging (DC, the "Charge" figure) + the inverter, which is the rest', () => {
    // 2026-11-11 23:39, the owner's panel: grid 5.66, UPS-Load 1.31, battery +4.17 → inverter 0.18.
    expect(gridLoad({ gridPowerW: 5660, batteryPowerW: 4170, upsLoadPowerW: 1310, loadPowerW: 1310 })).toEqual(split(5660, 1310, 4170, 180));
    // Batteries full and waiting: all of it is the house.
    expect(gridLoad({ gridPowerW: 1420, batteryPowerW: -45, upsLoadPowerW: 1420, loadPowerW: 0 })).toEqual(split(1420, 1420, 0, 0));
  });

  it('the house keeps its measured value when it took more than the grid gave: the rest came from the batteries', () => {
    // 2026-11-11 08:12: grid 834, UPS-Load 908, battery −105.
    const l = gridLoad({ gridPowerW: 834, batteryPowerW: -105, upsLoadPowerW: 908, loadPowerW: 908 });
    expect(l).toEqual(split(834, 908, 0, 0, { homeW: 834, batteryW: 0, inverterW: 0 }, { w: 74, from: 'batteries' }));
  });

  it('sun covering the house and charging: the bar holds the grid draw only', () => {
    expect(gridLoad({ gridPowerW: 1000, batteryPowerW: 900, upsLoadPowerW: 1500, pvPowerW: 1600 })).toEqual(
      split(1000, 1500, 900, 0, { homeW: 1000, batteryW: 0, inverterW: 0 }, { w: 500, from: 'sun' }),
    );
  });

  it('a few watts over the grid with no other source is two fields read apart, not worth a note', () => {
    expect(gridLoad({ gridPowerW: 281, batteryPowerW: -57, upsLoadPowerW: 288, pvPowerW: 0 })!.topped).toBeNull();
  });

  it('without a measured house load: grid minus charging', () => {
    expect(gridLoad({ gridPowerW: 7000, batteryPowerW: 4100 })).toEqual(split(7000, 2900, 4100, 0));
  });

  it('caps the battery share at the grid draw when the sun covers part of the charge', () => {
    expect(gridLoad({ gridPowerW: 3000, batteryPowerW: 4100 })).toEqual(split(3000, 0, 4100, 0, { homeW: 0, batteryW: 3000, inverterW: 0 }));
  });

  it('shows nothing on export, near-zero draw or missing data', () => {
    expect(gridLoad({ gridPowerW: -300, batteryPowerW: 0 })).toBeNull();
    expect(gridLoad({ gridPowerW: 20, batteryPowerW: 0 })).toBeNull();
    expect(gridLoad({ gridPowerW: null, batteryPowerW: 100 })).toBeNull();
  });
});

describe('batteryLoad', () => {
  it('out of the batteries = house + the inverter (2026-11-11 21:06: battery −1421, UPS-Load 1352)', () => {
    expect(batteryLoad({ batteryPowerW: -1421, upsLoadPowerW: 1352, loadPowerW: 1352 })).toEqual({
      totalW: 1421,
      homeW: 1352,
      inverterW: 69,
      bar: { homeW: 1352, inverterW: 69 },
      topped: null,
    });
  });

  it('sun covering part of the house during an outage', () => {
    expect(batteryLoad({ batteryPowerW: -400, upsLoadPowerW: 1200, pvPowerW: 900 })).toMatchObject({ totalW: 400, homeW: 1200, inverterW: 0, topped: { w: 800, from: 'sun' } });
  });

  it('battery power unknown: the house alone; no house load: nothing', () => {
    expect(batteryLoad({ batteryPowerW: null, upsLoadPowerW: 700 })).toMatchObject({ totalW: 700, homeW: 700, inverterW: 0 });
    expect(batteryLoad({ batteryPowerW: -700, upsLoadPowerW: null, loadPowerW: null })).toBeNull();
  });
});

describe('battery drain', () => {
  it('house + the inverter: matches the owner\'s outages within ~1 %', () => {
    // House → measured discharge on 2026-11-10/11.
    for (const [house, out] of [[254, 310], [1352, 1421], [2752, 2848], [405, 460]] as const) {
      expect(Math.abs(batteryDrainW(house) - out) / out).toBeLessThan(0.015);
    }
  });

  it('runtime uses the batteries\' own figure while discharging, the estimate while they wait', () => {
    expect(runtimeDrainW({ batteryPowerW: -1421, upsLoadPowerW: 1352, loadPowerW: 1352 })).toBe(1421);
    // A frame from just before the outage (batteries still waiting): the estimate, not their 40 W.
    expect(runtimeDrainW({ batteryPowerW: -40, upsLoadPowerW: 1000, loadPowerW: 1000 })).toBe(batteryDrainW(1000));
    expect(runtimeDrainW({ batteryPowerW: 0, upsLoadPowerW: 1000, loadPowerW: 1000 })).toBe(batteryDrainW(1000));
    expect(runtimeDrainW({ batteryPowerW: null, upsLoadPowerW: null, loadPowerW: null })).toBeNull();
  });

  it('with the grid on, the inverter\'s own use and a brief load step still count as waiting', () => {
    expect([-40, -105, -149, 99].map(batteriesIdleOnGrid)).toEqual([true, true, true, true]);
    expect([-150, -500, 100, 4170].map(batteriesIdleOnGrid)).toEqual([false, false, false, false]);
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

describe('runtimeColor', () => {
  it('ten steps by hours left, starting at the ring\'s 100 % colour', () => {
    expect([50, 48, 40, 30, 14, 10, 8, 5, 3, 1.5, 0.5, 0].map(runtimeColor)).toEqual([
      '#10b981', '#10b981', '#2dcb80', '#4ade80', '#76e25a', '#a3e635', '#ced925', '#facc15', '#f97316', '#ef4444', '#b91c1c', '#b91c1c',
    ]);
  });
});
