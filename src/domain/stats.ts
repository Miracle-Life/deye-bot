import { DateTime } from 'luxon';
import type { Interval, Reading } from '../deye/types.js';

export type SegState = 'on' | 'off' | 'unknown';
export interface Segment {
  start: number;
  end: number;
  state: SegState;
}
export interface Summary {
  onMs: number;
  offMs: number;
  unknownMs: number;
  outageCount: number;
  longestOutage: { start: number; ms: number } | null;
}

const H = 3_600_000;
export const CELL = { on: '🟩', off: '🟥', unknown: '⬜', future: '⬛' } as const;

const covers = (iv: Interval, t: number, now: number) => iv.start <= t && t < (iv.end ?? now);

export function buildTimeline(from: number, to: number, outages: Interval[], gaps: Interval[], nowMs: number): Segment[] {
  const end = Math.min(to, nowMs);
  if (end <= from) return [];
  const points = new Set<number>([from, end]);
  for (const iv of [...outages, ...gaps]) {
    for (const p of [iv.start, iv.end ?? nowMs]) if (p > from && p < end) points.add(p);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segs: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const state: SegState = gaps.some((g) => covers(g, a, nowMs))
      ? 'unknown'
      : outages.some((o) => covers(o, a, nowMs))
        ? 'off'
        : 'on';
    const last = segs[segs.length - 1];
    if (last && last.state === state) last.end = b;
    else segs.push({ start: a, end: b, state });
  }
  return segs;
}

export function summarize(segs: Segment[], outages: Interval[], from: number, to: number): Summary {
  const sum: Summary = { onMs: 0, offMs: 0, unknownMs: 0, outageCount: 0, longestOutage: null };
  for (const s of segs) sum[`${s.state}Ms`] += s.end - s.start;
  const rangeEnd = segs.length ? segs[segs.length - 1]!.end : to;
  for (const o of outages) {
    const oEnd = o.end ?? rangeEnd;
    if (o.start >= to || oEnd <= from) continue;
    sum.outageCount++;
    const ms = oEnd - o.start;
    if (!sum.longestOutage || ms > sum.longestOutage.ms) sum.longestOutage = { start: o.start, ms };
  }
  return sum;
}

export function hourStrip(from: number, to: number, segs: Segment[]): string {
  let out = '';
  for (let t = from; t < to; t += H) {
    const acc: Record<SegState, number> = { on: 0, off: 0, unknown: 0 };
    for (const s of segs) {
      const overlap = Math.min(s.end, t + H) - Math.max(s.start, t);
      if (overlap > 0) acc[s.state] += overlap;
    }
    const total = acc.on + acc.off + acc.unknown;
    if (total === 0) {
      out += CELL.future;
      continue;
    }
    const best = (Object.keys(acc) as SegState[]).reduce((a, b) => (acc[b] > acc[a] ? b : a), 'off' as SegState);
    out += CELL[best];
  }
  return out;
}

export function dayRange(dateIso: string, zone: string): { from: number; to: number } {
  const d = DateTime.fromISO(dateIso, { zone }).startOf('day');
  return { from: d.toMillis(), to: d.plus({ days: 1 }).toMillis() };
}

export function weekRange(anyDateIso: string, zone: string): { from: number; to: number } {
  const d = DateTime.fromISO(anyDateIso, { zone }).startOf('week'); // ISO week starts Monday
  return { from: d.toMillis(), to: d.plus({ weeks: 1 }).toMillis() };
}

export function monthRange(anyDateIso: string, zone: string): { from: number; to: number } {
  const d = DateTime.fromISO(anyDateIso, { zone }).startOf('month');
  return { from: d.toMillis(), to: d.plus({ months: 1 }).toMillis() };
}

export function minSoc(readings: Reading[]): { soc: number; ts: number } | null {
  let best: { soc: number; ts: number } | null = null;
  for (const r of readings) if (r.soc !== null && (!best || r.soc < best.soc)) best = { soc: r.soc, ts: r.ts };
  return best;
}

export function dischargedKwh(readings: Reading[], maxGapMs: number): number {
  let wh = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1]!;
    const b = readings[i]!;
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > maxGapMs) continue;
    const pa = Math.max(0, -(a.batteryPowerW ?? 0));
    const pb = Math.max(0, -(b.batteryPowerW ?? 0));
    wh += ((pa + pb) / 2) * (dt / H);
  }
  return wh / 1000;
}
