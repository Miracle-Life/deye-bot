// Past outage schedules: YASNO only shows today and tomorrow, so the bot keeps each day's last version.
import { DateTime } from 'luxon';
import type { Interval } from '../deye/types.js';
import { buildTimeline, dayRange, summarize } from '../domain/stats.js';
import type { DayStatus, Schedule, Span } from './model.js';

export interface ArchivedDay {
  date: string; // yyyy-mm-dd, Kyiv
  group: string;
  status: DayStatus;
  outages: Span[];
  plannedOutages: Span[]; // last published outages; kept when the day turns into emergency shutdowns
  updatedAt: number | null;
  fetchedAt: number;
}

const published = (s: DayStatus) => s === 'applies' || s === 'emergency';

/** Latest wins, except that "waiting"/"unknown" never erase a published day. */
export function mergeArchivedDay(old: ArchivedDay | null, incoming: ArchivedDay): ArchivedDay {
  if (old && published(old.status) && !published(incoming.status)) return old;
  if (incoming.status === 'applies') return { ...incoming, plannedOutages: incoming.outages };
  if (incoming.status === 'emergency' && old) return { ...incoming, plannedOutages: old.plannedOutages };
  return incoming;
}

export function toArchivedDays(s: Schedule): ArchivedDay[] {
  return s.days.map((d) => ({
    date: d.date,
    group: s.group,
    status: d.status,
    outages: d.outages,
    plannedOutages: d.status === 'applies' ? d.outages : [],
    updatedAt: s.updatedAt,
    fetchedAt: s.fetchedAt,
  }));
}

// --- aggregation for the week / month / 3-month cards -----------------------

export type DayKind = 'planned' | 'emergency' | 'nodata' | 'future';

export interface ArchiveDayStat {
  date: string;
  kind: DayKind;
  spans: Span[]; // planned outages (planned days only)
  plannedMs: number;
  actualMs: number | null; // from the bot's own outage records; null when unknown (future, before the data)
  dayMs: number; // 23 / 24 / 25 h
}

export interface PeriodTotals {
  plannedMs: number;
  actualMs: number;
  daysWithOutages: number;
  daysKnown: number; // planned + emergency days
  worst: { date: string; ms: number } | null; // by planned hours
}

const clipMs = (spans: Span[], from: number, to: number) => spans.reduce((a, s) => a + Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)), 0);

export function archiveStats(
  dates: string[],
  archived: Map<string, ArchivedDay>,
  outages: Interval[],
  gaps: Interval[],
  nowMs: number,
  zone: string,
  earliestDataTs: number | null,
): ArchiveDayStat[] {
  const tomorrow = DateTime.fromMillis(nowMs, { zone }).plus({ days: 1 }).toISODate()!;
  return dates.map((date) => {
    const { from, to } = dayRange(date, zone);
    const a = archived.get(date);
    const kind: DayKind = date > tomorrow || (from > nowMs && !a) ? 'future' : a?.status === 'applies' ? 'planned' : a?.status === 'emergency' ? 'emergency' : 'nodata';
    const spans = kind === 'planned' ? a!.outages : [];
    const known = from <= nowMs && earliestDataTs !== null && to > earliestDataTs;
    const actualMs = known ? summarize(buildTimeline(from, to, outages, gaps, nowMs), outages, from, to).offMs : null;
    return { date, kind, spans, plannedMs: clipMs(spans, from, to), actualMs, dayMs: to - from };
  });
}

export function totals(days: ArchiveDayStat[]): PeriodTotals {
  const t: PeriodTotals = { plannedMs: 0, actualMs: 0, daysWithOutages: 0, daysKnown: 0, worst: null };
  for (const d of days) {
    if (d.kind !== 'planned' && d.kind !== 'emergency') continue;
    t.daysKnown++;
    t.actualMs += d.actualMs ?? 0;
    if (d.kind !== 'planned') continue;
    t.plannedMs += d.plannedMs;
    if (d.plannedMs > 0) t.daysWithOutages++;
    if (d.plannedMs > 0 && (!t.worst || d.plannedMs > t.worst.ms)) t.worst = { date: d.date, ms: d.plannedMs };
  }
  return t;
}

const days = (start: DateTime, n: number) => Array.from({ length: n }, (_, i) => start.plus({ days: i }).toISODate()!);

/** Mon–Sun week containing the date. */
export function weekDates(anyDateIso: string, zone: string): string[] {
  return days(DateTime.fromISO(anyDateIso, { zone }).startOf('week'), 7);
}

/** 'yyyy-mm' → every day of that month. */
export function monthDates(monthIso: string, zone: string): string[] {
  const d = DateTime.fromISO(`${monthIso}-01`, { zone });
  return days(d, d.daysInMonth!);
}

/** 13 Mon–Sun weeks ending with the anchor's week. */
export function quarterWeeks(anchorIso: string, zone: string): string[][] {
  const last = DateTime.fromISO(anchorIso, { zone }).startOf('week');
  return Array.from({ length: 13 }, (_, i) => days(last.minus({ weeks: 12 - i }), 7));
}

/**
 * Planned hours per known day, last 4 weeks vs the 4 before (+0.25 = 25 % more). Per day, so the current,
 * partly known week doesn't drag the figure down.
 */
export function trend(weeks: PeriodTotals[]): number | null {
  const last8 = weeks.slice(-8);
  if (last8.length < 8 || last8.some((w) => w.daysKnown === 0)) return null;
  const perDay = (ws: PeriodTotals[]) => ws.reduce((a, w) => a + w.plannedMs, 0) / ws.reduce((a, w) => a + w.daysKnown, 0);
  const base = perDay(last8.slice(0, 4));
  return base === 0 ? null : perDay(last8.slice(4)) / base - 1;
}

// --- navigation (callback data: sa:w:<monday>, sa:m:<yyyy-mm>, sa:q:<monday of the last week>) ---

export type ArchiveKind = 'w' | 'm' | 'q';

const periodStart = (kind: ArchiveKind, iso: string, zone: string) => DateTime.fromISO(iso, { zone }).startOf(kind === 'm' ? 'month' : 'week');
const anchorOf = (kind: ArchiveKind, d: DateTime) => (kind === 'm' ? d.toFormat('yyyy-MM') : d.toISODate()!);

/** Callback anchor → a valid period: "now"/garbage → current, too old → the oldest stored, future → current. */
export function resolveArchiveAnchor(kind: ArchiveKind, raw: string, oldestIso: string | null, todayIso: string, zone: string): string {
  const current = periodStart(kind, todayIso, zone);
  const parsed = DateTime.fromISO(kind === 'm' && /^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw, { zone });
  let d = raw === 'now' || !parsed.isValid ? current : parsed.startOf(kind === 'm' ? 'month' : 'week');
  if (d > current) d = current;
  if (oldestIso) {
    const oldest = periodStart(kind, oldestIso, zone);
    if (d < oldest) d = oldest;
  }
  return anchorOf(kind, d);
}

/** ‹ only while the previous period still has archived days; › only before the current period. */
export function archiveNav(kind: ArchiveKind, anchor: string, oldestIso: string | null, todayIso: string, zone: string): { prev: string | null; next: string | null } {
  const start = periodStart(kind, kind === 'm' ? `${anchor}-01` : anchor, zone);
  const step = kind === 'm' ? { months: 1 } : kind === 'w' ? { weeks: 1 } : { weeks: 13 };
  const prev = start.minus(step);
  // The 3-month window ends with its anchor week, so it starts 12 weeks earlier.
  const prevEnd = (kind === 'q' ? start.minus({ weeks: 12 }) : start).minus({ days: 1 }).toISODate()!;
  const current = periodStart(kind, todayIso, zone);
  return {
    prev: oldestIso && prevEnd >= oldestIso ? `sa:${kind}:${anchorOf(kind, prev)}` : null,
    next: start < current ? `sa:${kind}:${anchorOf(kind, start.plus(step) > current ? current : start.plus(step))}` : null,
  };
}
