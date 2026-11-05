// Grid draw vs the main breaker: what the house pulls from the grid and what it's made of.
import type { Reading } from '../deye/types.js';

export const BREAKER_W = 8000;
export const LOAD_HYSTERESIS_W = 500;
export const MIN_SHOWN_W = 50;
export const NOMINAL_BATTERY_V = 51.2; // when the reading has no battery voltage
export const YELLOW_FROM_W = 4000;
export const ORANGE_FROM_W = 5500;

export interface GridLoad {
  totalW: number;
  homeW: number;
  batteryW: number;
}

export type LoadZone = 'green' | 'yellow' | 'orange' | 'red';

/** With sun the split is approximate: the batteries are assumed to charge from the grid first. */
export function gridLoad(r: Pick<Reading, 'gridPowerW' | 'batteryPowerW'>): GridLoad | null {
  const total = r.gridPowerW;
  if (total === null || total < MIN_SHOWN_W) return null;
  const batteryW = Math.min(Math.max(r.batteryPowerW ?? 0, 0), total);
  return { totalW: total, homeW: total - batteryW, batteryW };
}

export function loadZone(w: number, redFromW: number): LoadZone {
  if (w >= Math.min(redFromW, BREAKER_W)) return 'red';
  if (w >= ORANGE_FROM_W) return 'orange';
  if (w >= YELLOW_FROM_W) return 'yellow';
  return 'green';
}

export function stepGridLoad(high: boolean, totalW: number, thresholdW: number): { high: boolean; event: 'high' | 'ok' | null } {
  if (!high && totalW >= thresholdW) return { high: true, event: 'high' };
  if (high && totalW < thresholdW - LOAD_HYSTERESIS_W) return { high: false, event: 'ok' };
  return { high, event: null };
}

/**
 * Alert state per reading. An outage resets silently: no all-clear then, but the first
 * overload after power returns (batteries recharging at full rate) alerts again.
 */
export function gridWatchStep(
  high: boolean,
  grid: 'on' | 'off' | null,
  gridPowerW: number | null,
  thresholdW: number,
): { high: boolean; event: 'high' | 'ok' | null } {
  if (grid === 'off') return { high: false, event: null };
  if (gridPowerW === null) return { high, event: null };
  return stepGridLoad(high, Math.max(gridPowerW, 0), thresholdW);
}

// Battery mode: the breaker doesn't matter, the inverter and the batteries' discharge current do.
const BAT_YELLOW = 0.5;
const BAT_ORANGE = 0.7;
const BAT_RED = 0.9;
export const BATTERY_BANDS = { yellow: BAT_YELLOW, orange: BAT_ORANGE, red: BAT_RED };

export function batteryLimitW(dischargeA: number | null, batteryV: number, ratedW: number | null): number | null {
  const pos = (v: number | null) => (v !== null && v > 0 ? v : null); // 0 = not reported
  const byCurrent = pos(dischargeA === null ? null : Math.round(dischargeA * batteryV));
  const rated = pos(ratedW);
  if (byCurrent === null) return rated;
  return rated === null ? byCurrent : Math.min(byCurrent, rated);
}

export function batteryZone(w: number, limitW: number): LoadZone {
  const f = w / limitW;
  return f >= BAT_RED ? 'red' : f >= BAT_ORANGE ? 'orange' : f >= BAT_YELLOW ? 'yellow' : 'green';
}
