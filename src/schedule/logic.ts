// Pure decisions on top of the schedule model: what the tile, card, warnings and reminders show.
import { DateTime } from 'luxon';
import type { Schedule, Span } from './model.js';

const H = 3_600_000;
const ZONE = 'Europe/Kyiv';
/** Schedule and reality never line up exactly. */
export const GRACE_MS = 30 * 60_000;

export type TileState =
  | { kind: 'off-until'; until: number; endsAtDayEdge: boolean }
  | { kind: 'off-late'; due: number }
  | { kind: 'off-unscheduled' }
  | { kind: 'emergency' }
  | { kind: 'today-unpublished' }
  | { kind: 'on-in-slot'; from: number; until: number; early: boolean } // early: it was off in this slot and came back
  | { kind: 'next'; start: number; end: number }
  | { kind: 'none-today'; preliminary: true };

const dateOf = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toISODate()!;

/** Outages of published days only, contiguous ones merged (an outage over midnight is one span). */
export function publishedOutages(s: Schedule): Span[] {
  const out: Span[] = [];
  for (const d of s.days) {
    if (d.status !== 'applies') continue;
    for (const o of d.outages) {
      const last = out.at(-1);
      if (last && o.start <= last.end) last.end = Math.max(last.end, o.end);
      else out.push({ ...o });
    }
  }
  return out;
}

/**
 * What the schedule says about now. `outageStart` (when the current outage began) tells a late
 * power-on of a scheduled outage from a new, unscheduled one; `lastOnTs` (when the power last came
 * back) tells "not off yet" from "back ahead of schedule" inside a scheduled slot.
 */
export function tileState(s: Schedule, grid: 'on' | 'off' | null, nowMs: number, outageStart: number | null = null, lastOnTs: number | null = null): TileState | null {
  if (grid === null) return null;
  const today = s.days.find((d) => d.date === dateOf(nowMs));
  if (!today || today.status === 'waiting' || today.status === 'unknown') return { kind: 'today-unpublished' };
  if (today.status === 'emergency') return { kind: 'emergency' };
  const spans = publishedOutages(s);

  if (grid === 'off') {
    const cover = spans.find((o) => nowMs >= o.start - GRACE_MS && nowMs < o.end + GRACE_MS);
    if (cover) {
      return { kind: 'off-until', until: cover.end, endsAtDayEdge: endsAtUnpublishedEdge(s, cover.end) };
    }
    const ended = spans.filter((o) => o.end <= nowMs).at(-1);
    if (ended && outageStart !== null && outageStart < ended.end) return { kind: 'off-late', due: ended.end };
    return { kind: 'off-unscheduled' };
  }

  const inSlot = spans.find((o) => nowMs >= o.start && nowMs < o.end);
  if (inSlot) return { kind: 'on-in-slot', from: inSlot.start, until: inSlot.end, early: lastOnTs !== null && lastOnTs >= inSlot.start && lastOnTs <= nowMs };
  const next = spans.find((o) => o.start > nowMs);
  if (next) return { kind: 'next', start: next.start, end: next.end };
  return { kind: 'none-today', preliminary: true };
}

/** When power should come back, if the schedule covers the current outage. */
export function powerOnTarget(state: TileState | null): number | null {
  // 24:00 with tomorrow unpublished is not a real power-on time.
  return state?.kind === 'off-until' && !state.endsAtDayEdge ? state.until : null;
}

const round10 = (w: number) => Math.round(w / 10) * 10;

/** Will the batteries last until `targetMs` at the current discharge? If not, what house load would. */
export function batteryVerdict(
  soc: number,
  dischargeW: number,
  pvW: number,
  nowMs: number,
  targetMs: number,
  o: { capacityKwh: number; reservePct: number },
): { ok: true } | { ok: false; endsAt: number; adviseLoadW: number } {
  const hoursLeft = (targetMs - nowMs) / H;
  if (hoursLeft <= 0 || dischargeW <= 0) return { ok: true };
  const usableWh = (Math.max(0, soc - o.reservePct) / 100) * o.capacityKwh * 1000;
  const runtimeH = usableWh / dischargeW;
  if (runtimeH >= hoursLeft) return { ok: true };
  // Solar covers part of the house load, so the allowed house load is higher by the current PV.
  return { ok: false, endsAt: nowMs + runtimeH * H, adviseLoadW: round10(usableWh / hoursLeft + pvW) };
}

/** Projected charge at `toMs` with the current charge power, capped at 100. */
export function socAt(soc: number, chargeW: number, capacityKwh: number, fromMs: number, toMs: number): number {
  const gained = ((chargeW * ((toMs - fromMs) / H)) / (capacityKwh * 1000)) * 100;
  return Math.min(100, Math.round(soc + Math.max(0, gained)));
}

export interface Reminder {
  kind: 'off' | 'on';
  at: number; // event time
  key: string; // dedupe: a moved event gets a new key
}

/** Reminders due now for one user setting (`leadMin` before the scheduled off/on). */
export function dueReminders(
  s: Schedule,
  grid: 'on' | 'off' | null,
  nowMs: number,
  leadMin: number,
  kind: 'off' | 'on',
  sent: ReadonlySet<string>,
): Reminder[] {
  if (leadMin <= 0) return [];
  // Already there (power went off early / came back early): nothing to warn about.
  if ((kind === 'off' && grid === 'off') || (kind === 'on' && grid === 'on')) return [];
  const lead = leadMin * 60_000;
  const out: Reminder[] = [];
  for (const o of publishedOutages(s)) {
    const at = kind === 'off' ? o.start : o.end;
    // An end at midnight with the next day unpublished is not a real power-on time.
    if (kind === 'on' && endsAtUnpublishedEdge(s, o.end)) continue;
    const key = `${kind}@${at}`;
    if (nowMs >= at - lead && nowMs < at && !sent.has(key)) out.push({ kind, at, key });
  }
  return out;
}

function endsAtUnpublishedEdge(s: Schedule, end: number): boolean {
  const atMidnight = DateTime.fromMillis(end, { zone: ZONE }).startOf('day').toMillis() === end;
  return atMidnight && s.days.find((d) => d.date === dateOf(end))?.status !== 'applies';
}

const STALE_MS = 2 * H;
const MANUAL_GAP_MS = 60_000;

export const isStale = (s: Schedule, nowMs: number) => nowMs - s.fetchedAt > STALE_MS;

/** "Refresh" taps hit YASNO at most once a minute (all users together). */
export const refreshAllowed = (lastManualMs: number | null, nowMs: number) => lastManualMs === null || nowMs - lastManualMs >= MANUAL_GAP_MS;
