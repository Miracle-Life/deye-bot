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
/**
 * With the grid on, full batteries keep giving the inverter its own ~40–60 W, and a load step briefly
 * takes ~100 W more before the grid catches up: that much discharge still means "batteries wait".
 */
export const GRID_STANDBY_DISCHARGE_W = 150;

/** Batteries wait (neither charging nor really discharging) while the grid is on. */
export const batteriesIdleOnGrid = (batteryPowerW: number) => batteryPowerW < BATTERY_IDLE_W && batteryPowerW > -GRID_STANDBY_DISCHARGE_W;

/**
 * Full batteries on the grid slowly give the inverter its ~40 W; once their voltage sags (~53.2 V on the owner's
 * pack, every few hours) the inverter tops them up for a few minutes at ~1.7 kW while the BMS still says 100 %.
 */
export const TOP_UP_SOC = 99;
export const toppingUp = (soc: number | null, batteryPowerW: number) => soc !== null && soc >= TOP_UP_SOC && batteryPowerW >= BATTERY_IDLE_W;

/**
 * What the batteries would give for this house load: the inverter's own ~55 W plus ~1 % conversion.
 * Fitted on 350 readings from the owner's outages (median overhead 53 W, ~95 W above 2 kW).
 */
export const INVERTER_OWN_W = 55;
export const INVERTER_LOSS = 0.01;
export const batteryDrainW = (houseW: number) => Math.round(houseW * (1 + INVERTER_LOSS) + INVERTER_OWN_W);

/**
 * For runtime: really discharging, the batteries' own figure (house + inverter, less any sun); otherwise (waiting
 * on the grid, or a frame from just before the outage) what they'd give the house.
 */
export function runtimeDrainW(r: Pick<Reading, 'batteryPowerW' | 'upsLoadPowerW' | 'loadPowerW'>): number | null {
  if (r.batteryPowerW !== null && r.batteryPowerW <= -BATTERY_IDLE_W) return -r.batteryPowerW;
  const house = r.upsLoadPowerW ?? r.loadPowerW;
  return house !== null ? batteryDrainW(house) : null;
}

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

/** Where the house load came from beyond the bar's source (part of it from the batteries or the sun). */
export interface Topped {
  w: number;
  from: 'batteries' | 'sun';
}

export interface GridLoad {
  totalW: number; // grid draw
  homeW: number; // what the house takes, as measured (the "Home" tile)
  batteryW: number; // into the batteries, DC, as the battery reports it (the "Charge" figure)
  inverterW: number; // the rest of the grid draw: AC→DC conversion and the inverter's own use
  // Bar shares of totalW (they add up to it): the house can take more than the grid gives.
  bar: { homeW: number; batteryW: number; inverterW: number };
  topped: Topped | null;
}

export type LoadZone = 'green' | 'yellow' | 'orange' | 'red';

/** The house took noticeably more than the bar's source gave: from where. */
function topped(extraW: number, dischargeW: number, pvW: number): Topped | null {
  if (extraW < MIN_SHOWN_W) return null;
  if (dischargeW >= MIN_SHOWN_W) return { w: extraW, from: 'batteries' };
  if (pvW >= MIN_SHOWN_W) return { w: extraW, from: 'sun' };
  return null; // two fields read a moment apart, not a real source
}

/**
 * Grid draw = house + charging (DC, the same figure as "Charge") + the inverter: AC→DC conversion and its own
 * use (~4.5 %: 4.17 kW into the batteries takes ~4.35 kW from the grid). Each part is what Deye measures, so the
 * legend matches the "Home" tile and the "Charge" figure; the inverter is what's left. Without a measured house
 * load the house is grid minus charging (the inverter's share is then inside it).
 */
export function gridLoad(
  r: Pick<Reading, 'gridPowerW' | 'batteryPowerW'> & Partial<Pick<Reading, 'upsLoadPowerW' | 'loadPowerW' | 'pvPowerW'>>,
): GridLoad | null {
  const total = r.gridPowerW;
  if (total === null || total < MIN_SHOWN_W) return null;
  const bat = r.batteryPowerW ?? 0;
  const charge = Math.max(bat, 0);
  const measured = r.upsLoadPowerW ?? r.loadPowerW ?? null;
  const house = measured !== null ? Math.max(measured, 0) : Math.max(total - charge, 0);
  const homeBar = Math.min(house, total);
  const batteryBar = Math.min(charge, total - homeBar);
  const inverterBar = total - homeBar - batteryBar;
  return {
    totalW: total,
    homeW: house,
    batteryW: charge,
    inverterW: inverterBar,
    bar: { homeW: homeBar, batteryW: batteryBar, inverterW: inverterBar },
    topped: topped(house - total, Math.max(-bat, 0), Math.max(r.pvPowerW ?? 0, 0)),
  };
}

export interface BatteryLoad {
  totalW: number; // out of the batteries, DC (the "Discharge" figure)
  homeW: number;
  inverterW: number; // the inverter's own use and conversion
  bar: { homeW: number; inverterW: number };
  topped: Topped | null; // the sun covering part of the house
}

/**
 * During an outage: what the batteries give = house + the inverter (its own ~45 W and conversion). With the
 * battery power unknown, the house alone.
 */
export function batteryLoad(r: Pick<Reading, 'batteryPowerW'> & Partial<Pick<Reading, 'upsLoadPowerW' | 'loadPowerW' | 'pvPowerW'>>): BatteryLoad | null {
  const measured = r.upsLoadPowerW ?? r.loadPowerW ?? null;
  if (measured === null) return null;
  const house = Math.max(measured, 0);
  const total = r.batteryPowerW === null ? house : Math.max(-r.batteryPowerW, 0);
  const homeBar = Math.min(house, total);
  return {
    totalW: total,
    homeW: house,
    inverterW: total - homeBar,
    bar: { homeW: homeBar, inverterW: total - homeBar },
    topped: topped(house - total, 0, r.batteryPowerW === null ? 0 : Math.max(r.pvPowerW ?? 0, 0)),
  };
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
