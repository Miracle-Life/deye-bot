// Battery health estimates from readings: real capacity from deep discharges, temperatures, wear.
import type { Reading } from '../deye/types.js';

const H = 3_600_000;
const DAY = 24 * H;

export interface CapacityRun {
  startTs: number;
  endTs: number;
  socFrom: number;
  socTo: number;
  energyKwh: number;
  estimateKwh: number; // energy / (drop / 100)
}

type Pt = { ts: number; soc: number; w: number };

/**
 * Deep discharges usable for a capacity estimate. A run is trimmed to where the charge
 * actually falls: standby draw at 100 % (tens of watts for hours) must not count.
 */
export function findCapacityRuns(readings: Reading[], minDropPct = 20, maxGapMs = 10 * 60_000): CapacityRun[] {
  const pts: Pt[] = readings
    .filter((r): r is Reading & { soc: number; batteryPowerW: number } => r.soc !== null && r.batteryPowerW !== null)
    .map((r) => ({ ts: r.ts, soc: r.soc, w: r.batteryPowerW }))
    .sort((a, b) => a.ts - b.ts);

  // Split into discharge segments: charge/idle or a long silence ends one.
  const segments: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of pts) {
    const prev = cur.at(-1);
    if (p.w >= 0 || (prev && p.ts - prev.ts > maxGapMs)) {
      if (cur.length > 1) segments.push(cur);
      cur = p.w < 0 ? [p] : [];
      continue;
    }
    cur.push(p);
  }
  if (cur.length > 1) segments.push(cur);

  const runs: CapacityRun[] = [];
  for (const seg of segments) {
    const first = seg.findIndex((p, i) => i + 1 < seg.length && seg[i + 1]!.soc < p.soc);
    if (first < 0) continue;
    let last = first;
    for (let i = first + 1; i < seg.length; i++) if (seg[i]!.soc < seg[i - 1]!.soc) last = i;
    const drop = seg[first]!.soc - seg[last]!.soc;
    if (drop < minDropPct) continue;
    let wh = 0;
    for (let i = first; i < last; i++) wh += -seg[i]!.w * ((seg[i + 1]!.ts - seg[i]!.ts) / H);
    const energyKwh = wh / 1000;
    runs.push({ startTs: seg[first]!.ts, endTs: seg[last]!.ts, socFrom: seg[first]!.soc, socTo: seg[last]!.soc, energyKwh, estimateKwh: energyKwh / (drop / 100) });
  }
  return runs;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Shown value: median of the last 5 estimates (single ones are noisy: BMS percentages are coarse). */
export function capacitySummary(runs: CapacityRun[], nominalKwh: number, nowMs: number): { estimateKwh: number | null; pct: number | null; trendPct: number | null } {
  const sorted = [...runs].sort((a, b) => a.endTs - b.endTs);
  const estimateKwh = median(sorted.slice(-5).map((r) => r.estimateKwh));
  const recent = median(sorted.filter((r) => nowMs - r.endTs <= 30 * DAY).map((r) => r.estimateKwh));
  const before = median(sorted.filter((r) => nowMs - r.endTs > 30 * DAY && nowMs - r.endTs <= 60 * DAY).map((r) => r.estimateKwh));
  return {
    estimateKwh,
    pct: estimateKwh === null ? null : Math.round((estimateKwh / nominalKwh) * 100),
    trendPct: recent === null || before === null ? null : Math.round(((recent - before) / nominalKwh) * 1000) / 10,
  };
}

export interface BatteryDay {
  date: string; // yyyy-mm-dd, Kyiv
  maxTempC: number | null;
  avgTempC: number | null;
  minAbove35: number;
  minAboveLimit: number;
  minSoc: number | null;
  maxSoc: number | null;
  dischargeTotalKwh: number | null; // lifetime counters at the end of the day
  chargeTotalKwh: number | null;
}

const HOT_C = 35;
const MAX_STEP_MS = 10 * 60_000; // a silence must not count as hours at the last temperature

/** One day's summary from that day's readings. Readings without a temperature (history backfill) are skipped. */
export function aggregateDay(date: string, readings: Reading[], limitC: number): BatteryDay {
  const rs = [...readings].sort((a, b) => a.ts - b.ts);
  const temps: number[] = [];
  let above35 = 0;
  let aboveLimit = 0;
  rs.forEach((r, i) => {
    if (r.batteryTempC === null) return;
    temps.push(r.batteryTempC);
    const step = Math.min((rs[i + 1]?.ts ?? r.ts + MAX_STEP_MS) - r.ts, MAX_STEP_MS) / 60_000;
    if (r.batteryTempC > HOT_C) above35 += step;
    if (r.batteryTempC >= limitC) aboveLimit += step;
  });
  const socs = rs.map((r) => r.soc).filter((s): s is number => s !== null);
  const lastOf = (f: (r: Reading) => number | null) => rs.map(f).filter((v): v is number => v !== null).at(-1) ?? null;
  return {
    date,
    maxTempC: temps.length ? Math.max(...temps) : null,
    avgTempC: temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null,
    minAbove35: Math.round(above35),
    minAboveLimit: Math.round(aboveLimit),
    minSoc: socs.length ? Math.min(...socs) : null,
    maxSoc: socs.length ? Math.max(...socs) : null,
    // A 0 from the cloud is a glitch, not the lifetime total.
    dischargeTotalKwh: lastOf((r) => (r.dischargeTotalKwh ? r.dischargeTotalKwh : null)),
    chargeTotalKwh: lastOf((r) => (r.chargeTotalKwh ? r.chargeTotalKwh : null)),
  };
}

/**
 * Energy discharged over the batteries' life. Only a drop to under half counts as a counter reset
 * (new inverter / firmware); small dips and spikes are cloud glitches and must not inflate cycles forever.
 */
export function lifetimeDischargeKwh(days: BatteryDay[], latest: number | null, maxStepKwh = Infinity): number {
  const values = [...days.map((d) => d.dischargeTotalKwh), latest].filter((v): v is number => v !== null && v > 0);
  let total = 0;
  let prev: number | null = null;
  for (const v of values) {
    if (prev === null) {
      total = v;
      prev = v;
    } else if (v < prev * 0.5) {
      total += v; // reset: the counter started again from 0
      prev = v;
    } else if (v > prev && v - prev <= maxStepKwh) {
      total += v - prev;
      prev = v;
    } // a dip, or an impossible jump: ignore this value
  }
  return Math.round(total * 100) / 100;
}

/**
 * One discharge can be seen by several scan windows (nightly 48 h, weekly chunks): keep one run per
 * discharge — a stored run that contains the new one wins, a new one that contains stored ones replaces them,
 * and for a partial overlap the deeper run stays.
 */
export function mergeRuns(stored: CapacityRun[], incoming: CapacityRun[]): { put: CapacityRun[]; remove: number[] } {
  const keep = new Map(stored.map((r) => [r.startTs, r]));
  const put = new Map<number, CapacityRun>();
  const remove = new Set<number>();
  const overlaps = (a: CapacityRun, b: CapacityRun) => a.startTs < b.endTs && b.startTs < a.endTs;
  const drop = (r: CapacityRun) => r.socFrom - r.socTo;
  for (const r of incoming) {
    const clash = [...keep.values()].filter((s) => overlaps(s, r) || s.startTs === r.startTs);
    if (clash.some((s) => drop(s) >= drop(r))) continue;
    for (const s of clash) {
      keep.delete(s.startTs);
      if (put.has(s.startTs)) put.delete(s.startTs);
      else remove.add(s.startTs);
    }
    keep.set(r.startTs, r);
    put.set(r.startTs, r);
  }
  return { put: [...put.values()], remove: [...remove] };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Two rough wear figures: cycles against the rated life, and capacity lost against nominal (never below 0). */
export function wear(cycles: number, ratedCycles: number, estimateKwh: number | null, nominalKwh: number): { byCyclesPct: number; byCapacityPct: number | null } {
  return {
    byCyclesPct: round1((cycles / ratedCycles) * 100),
    byCapacityPct: estimateKwh === null ? null : Math.max(0, round1((1 - estimateKwh / nominalKwh) * 100)),
  };
}
