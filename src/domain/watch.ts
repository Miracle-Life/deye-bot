// Pure checks for technical problems: overheating, inverter alerts, "won't last until morning".
import { DateTime } from 'luxon';
import type { Reading } from '../deye/types.js';
import { runtimeHours } from './forecast.js';
import type { GridLoad } from './load.js';

const H = 3_600_000;
const HYSTERESIS_C = 5;
const NIGHT_FROM_HOUR = 18;
export const MORNING_HOUR = 7;
const ALERT_MEMORY_MS = 7 * 24 * H;

export type TempWhich = 'battery' | 'inverter';
export type TempState = Record<TempWhich, boolean>; // true = currently over the limit

export interface DeyeAlert {
  id: string;
  code: string | null;
  name: string;
  level: string | null;
  startTs: number | null;
  endTs: number | null;
}

export type KnownAlerts = Record<string, { active: boolean; seenAt: number }>;

export interface WatchState {
  temps: TempState;
  nightWarnFor: string | null; // morning date already warned about
  alerts: KnownAlerts;
  alertsInit: boolean;
  gridHigh: boolean; // grid draw is over the alert threshold
}

export const initialWatch: WatchState = { temps: { battery: false, inverter: false }, nightWarnFor: null, alerts: {}, alertsInit: false, gridHigh: false };

export type WatchEvent =
  | { type: 'grid_high'; load: GridLoad; limitW: number }
  | { type: 'grid_ok'; totalW: number }
  | { type: 'temp_high' | 'temp_ok'; which: TempWhich; tempC: number; limitC: number }
  | { type: 'alert_new' | 'alert_end'; alert: DeyeAlert }
  // target 'schedule': morningTs is the scheduled power-on; needW is the house load that would last until then.
  | { type: 'night_short'; soc: number; loadW: number; endsAt: number; needW: number; morningTs: number; target?: 'schedule' | 'morning' };

export function stepTemps(
  s: TempState,
  r: Pick<Reading, 'batteryTempC' | 'inverterTempC'>,
  limits: { batteryMaxC: number; inverterMaxC: number },
): { state: TempState; events: WatchEvent[] } {
  const state = { ...s };
  const events: WatchEvent[] = [];
  const check = (which: TempWhich, t: number | null, limitC: number) => {
    if (t === null) return;
    if (!state[which] && t >= limitC) {
      state[which] = true;
      events.push({ type: 'temp_high', which, tempC: t, limitC });
    } else if (state[which] && t <= limitC - HYSTERESIS_C) {
      state[which] = false;
      events.push({ type: 'temp_ok', which, tempC: t, limitC });
    }
  };
  check('battery', r.batteryTempC, limits.batteryMaxC);
  check('inverter', r.inverterTempC, limits.inverterMaxC);
  return { state, events };
}

/** During an evening/night outage: when the battery would run out before 07:00, and what load would last. */
export function nightShortfall(
  soc: number,
  loadW: number,
  nowMs: number,
  cfg: { capacityKwh: number; reservePct: number; timezone: string },
): { endsAt: number; needW: number; morningKey: string; morningTs: number } | null {
  const now = DateTime.fromMillis(nowMs, { zone: cfg.timezone });
  if (now.hour < NIGHT_FROM_HOUR && now.hour >= MORNING_HOUR) return null;
  const morning = (now.hour >= NIGHT_FROM_HOUR ? now.plus({ days: 1 }) : now).set({ hour: MORNING_HOUR, minute: 0, second: 0, millisecond: 0 });
  const h = runtimeHours(soc, loadW, cfg.capacityKwh, cfg.reservePct);
  if (h === null) return null;
  const endsAt = nowMs + h * H;
  if (endsAt >= morning.toMillis()) return null;
  const usableWh = (Math.max(0, soc - cfg.reservePct) / 100) * cfg.capacityKwh * 1000;
  return { endsAt, needW: usableWh / ((morning.toMillis() - nowMs) / H), morningKey: morning.toISODate()!, morningTs: morning.toMillis() };
}

export function diffAlerts(known: KnownAlerts, list: DeyeAlert[], firstRun: boolean, nowMs = Date.now()): { known: KnownAlerts; events: WatchEvent[] } {
  const next: KnownAlerts = {};
  for (const [id, k] of Object.entries(known)) if (nowMs - k.seenAt < ALERT_MEMORY_MS) next[id] = k;
  const events: WatchEvent[] = [];
  for (const a of list) {
    const k = next[a.id];
    const active = a.endTs === null;
    if (!k) {
      if (!firstRun || active) events.push({ type: 'alert_new', alert: a });
    } else if (k.active && !active) {
      events.push({ type: 'alert_end', alert: a });
    }
    next[a.id] = { active, seenAt: nowMs };
  }
  return { known: next, events };
}

const REWARN_SHIFT_MS = 30 * 60_000;

/**
 * Dedupe of the "may not last" warning. Keys: `sched@<power-on ms>` or the morning date.
 * A scheduled power-on that moved later by ≥ 30 min warns again; small shifts don't.
 */
export function shouldWarnShort(prevKey: string | null, key: string): boolean {
  if (prevKey === key) return false;
  const ts = (k: string | null) => (k?.startsWith('sched@') ? Number(k.slice(6)) : null);
  const a = ts(prevKey);
  const b = ts(key);
  return a === null || b === null || b - a >= REWARN_SHIFT_MS;
}
