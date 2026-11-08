// Load against what the system can give: grid draw (house + charging) and, during an outage, the batteries.
import type { Reading } from '../deye/types.js';

// "Lasts about": colour by hours left. Starts at the battery ring's 100 % colour and follows the ring's
// colours down; the in-between shades fill the steps above 12 h.
const RUNTIME_STEPS: [number, string][] = [
  [48, '#10b981'],
  [36, '#2dcb80'],
  [24, '#4ade80'],
  [12, '#76e25a'],
  [9, '#a3e635'],
  [6, '#ced925'],
  [4, '#facc15'],
  [2, '#f97316'],
  [1, '#ef4444'],
  [0, '#b91c1c'],
];

export const runtimeColor = (hours: number) => RUNTIME_STEPS.find(([from]) => hours >= from)?.[1] ?? RUNTIME_STEPS.at(-1)![1];

/** Battery power this small (either way) counts as idle: full batteries just trickle. */
export const BATTERY_IDLE_W = 100;

export const DEFAULT_RATED_W = 10_000; // SUN-10K; used when the inverter doesn't report its rating
export const LOAD_HYSTERESIS_W = 500;
export const MIN_SHOWN_W = 50;
export const NOMINAL_BATTERY_V = 51.2; // when the reading has no battery voltage

/** Deye sometimes reports 0 V: treat anything ≤ 0 as unknown. */
export const batteryV = (v: number | null) => (v !== null && v > 0 ? v : NOMINAL_BATTERY_V);
export const GRID_YELLOW_W = 5000;
export const GRID_ORANGE_W = 6500;
// Full discharge current sags the battery ~3 % and the inverter is ~94 % efficient.
export const BATTERY_DERATE = 0.89;

const pos = (v: number | null) => (v !== null && v > 0 ? v : null); // 0 = not reported

/** Bar scale with grid: the inverter's rating. */
export function gridScaleW(ratedW: number | null): number {
  return pos(ratedW) ?? DEFAULT_RATED_W;
}

/** What grid charging takes at the configured current (Batt set2 → Grid Charge; the cloud doesn't report it). */
export function gridChargeW(gridChargeA: number, batteryV: number): number {
  return Math.round(gridChargeA * batteryV);
}

export interface GridLoad {
  totalW: number;
  homeW: number;
  batteryW: number;
}

export type LoadZone = 'green' | 'yellow' | 'orange' | 'red';

/**
 * Grid draw split into the house and charging. The house is what the inverter measures going to it (UPS-Load),
 * so it matches the "Home" tile; charging is the rest of the grid draw, i.e. its AC side with conversion losses
 * (~4.5 %: 4.13 kW into the batteries takes ~4.31 kW from the grid). Without a measured house load: grid minus
 * the battery's DC power. With sun the split is approximate.
 */
export function gridLoad(r: Pick<Reading, 'gridPowerW' | 'batteryPowerW'> & Partial<Pick<Reading, 'upsLoadPowerW' | 'loadPowerW'>>): GridLoad | null {
  const total = r.gridPowerW;
  if (total === null || total < MIN_SHOWN_W) return null;
  const house = r.upsLoadPowerW ?? r.loadPowerW ?? null;
  if (house !== null) {
    const homeW = Math.min(Math.max(house, 0), total);
    return { totalW: total, homeW, batteryW: total - homeW };
  }
  const batteryW = Math.min(Math.max(r.batteryPowerW ?? 0, 0), total);
  return { totalW: total, homeW: total - batteryW, batteryW };
}

export function loadZone(w: number, redFromW: number): LoadZone {
  if (w >= redFromW) return 'red';
  if (w >= GRID_ORANGE_W) return 'orange';
  if (w >= GRID_YELLOW_W) return 'yellow';
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

/** What the inverter can give from the batteries: discharge current × voltage, derated, capped by its rating. */
export function batteryScaleW(dischargeA: number | null, batteryV: number, ratedW: number | null): number {
  const rated = pos(ratedW) ?? DEFAULT_RATED_W;
  const a = pos(dischargeA);
  return a === null ? rated : Math.min(rated, Math.round(a * batteryV * BATTERY_DERATE));
}

/** Bar fractions where each zone starts; red from the alert threshold (or the scale end if it's above). */
export function batteryBands(scaleW: number, redFromW: number): { yellow: number; orange: number; red: number } {
  const red = Math.min(1, redFromW / scaleW);
  return { yellow: Math.min(BAT_YELLOW, red), orange: Math.min(BAT_ORANGE, red), red };
}

/**
 * Battery overload alert per reading. Grid back resets silently (mirror of gridWatchStep, which resets on an outage).
 */
export function batteryWatchStep(
  high: boolean,
  grid: 'on' | 'off' | null,
  loadW: number | null,
  thresholdW: number,
): { high: boolean; event: 'high' | 'ok' | null } {
  if (grid === 'on') return { high: false, event: null };
  if (grid === null || loadW === null) return { high, event: null };
  return stepGridLoad(high, Math.max(loadW, 0), thresholdW);
}

export const BATTERY_ALERT_GAP_MS = 15 * 60_000;
export interface BatteryAlertState {
  alertedAt: number | null; // last overload alert actually sent
  alerted: boolean; // the current overload was announced (so its all-clear is too)
}

/** Everyone gets this alert: at most one per 15 min when the load keeps crossing the threshold. */
export function batteryAlertGate(s: BatteryAlertState, event: 'high' | 'ok', nowMs: number): { send: boolean; state: BatteryAlertState } {
  if (event === 'ok') return { send: s.alerted, state: { ...s, alerted: false } };
  if (s.alertedAt !== null && nowMs - s.alertedAt < BATTERY_ALERT_GAP_MS) return { send: false, state: { ...s, alerted: false } };
  return { send: true, state: { alertedAt: nowMs, alerted: true } };
}

export function batteryZone(w: number, scaleW: number, redFromW: number): LoadZone {
  const b = batteryBands(scaleW, redFromW);
  const f = w / scaleW;
  return f >= b.red ? 'red' : f >= b.orange ? 'orange' : f >= b.yellow ? 'yellow' : 'green';
}
