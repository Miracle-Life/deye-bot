// Past schedules: week / month / 3-month cards. View-models (already formatted) and their SVG.
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import type { Dict } from '../i18n/index.js';
import { totals, trend, type ArchiveDayStat, type DayKind } from '../schedule/archive.js';
import { C, CARD_W, fitFont, frame, plain, statsRow, TONE } from './cards.js';
import type { Stat, Tone } from './models.js';

const H = 3_600_000;

/** 4.5 / 12 / 0.5 — one decimal, no trailing ".0". */
const num = (ms: number) => String(Math.round((ms / H) * 10) / 10);
const hrs = (ms: number, t: Dict) => t.archive.hours(num(ms));
/** Actual hours, shown grey next to the planned ones: "(4)". */
const bracket = (ms: number | null) => (ms === null ? '' : `(${num(ms)})`);

const sub = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ');

export interface ArchiveRow {
  label: string;
  kind: DayKind;
  bar: { x0: number; x1: number }[]; // planned outages as fractions of the day
  text: string;
  sub: string; // actual hours in brackets, grey
  tone: Tone;
}

export interface WeekArchiveModel {
  title: string;
  subtitle: string;
  stats: Stat[];
  rows: ArchiveRow[];
  ticks: string[];
  footnote: string;
  caption: string;
}

function rowText(d: ArchiveDayStat, t: Dict): { text: string; sub: string; tone: Tone } {
  switch (d.kind) {
    case 'future':
      return { text: '', sub: '', tone: 'muted' };
    case 'nodata':
      return { text: t.archive.noData, sub: '', tone: 'muted' };
    case 'emergency':
      return { text: t.archive.emergency, sub: bracket(d.actualMs), tone: 'amber' };
    default:
      if (d.plannedMs > 0) return { text: hrs(d.plannedMs, t), sub: bracket(d.actualMs), tone: 'red' };
      return { text: '—', sub: d.actualMs ? bracket(d.actualMs) : '', tone: 'green' };
  }
}

const totalStat = (label: string, planned: number, actual: number, t: Dict): Stat => ({ label, value: hrs(planned, t), sub: `(${num(actual)})`, tone: 'red' });
const dt = (date: string, cfg: Config, t: Dict) => DateTime.fromISO(date, { zone: cfg.timezone }).setLocale(t.locale);

function rangeText(first: string, last: string, cfg: Config, t: Dict): string {
  const a = dt(first, cfg, t);
  const b = dt(last, cfg, t);
  return a.month === b.month ? `${a.day} – ${b.toFormat('d MMMM')}` : `${a.toFormat('d MMM')} – ${b.toFormat('d MMM')}`;
}

export function weekArchiveModel(days: ArchiveDayStat[], group: string | null, _nowMs: number, cfg: Config, t: Dict): WeekArchiveModel {
  const tot = totals(days);
  const longest = Math.max(0, ...days.filter((d) => d.kind === 'planned').flatMap((d) => d.spans.map((s) => s.end - s.start)));
  const range = rangeText(days[0]!.date, days.at(-1)!.date, cfg, t);
  return {
    title: t.archive.weekTitle,
    subtitle: sub([range, group ? t.archive.group(group) : null]),
    stats: [
      totalStat(t.archive.withoutPower, tot.plannedMs, tot.actualMs, t),
      { label: t.archive.daysWith, value: t.archive.of(tot.daysWithOutages, tot.daysKnown), tone: 'plain' },
      { label: t.archive.longest, value: longest ? hrs(longest, t) : '—', tone: 'plain' },
    ],
    rows: days.map((d) => {
      const day = dt(d.date, cfg, t);
      const start = day.startOf('day').toMillis();
      return {
        label: `${cap(day.toFormat('ccc'))} ${day.day}`,
        kind: d.kind,
        bar: d.spans.map((s) => ({ x0: clamp01((s.start - start) / d.dayMs), x1: clamp01((s.end - start) / d.dayMs) })),
        ...rowText(d, t),
      };
    }),
    ticks: ['00', '06', '12', '18', '24'],
    footnote: t.archive.footnote,
    caption: `🗓 <b>${t.archive.weekTitle}</b> · ${range}`,
  };
}

export interface MonthCell {
  day: number;
  kind: DayKind;
  lines: string[]; // planned hours, (actual)
  fill: string;
}

export interface MonthArchiveModel {
  title: string;
  subtitle: string;
  stats: Stat[];
  weekdays: string[];
  offset: number; // empty cells before the 1st (Mon = 0)
  cells: MonthCell[];
  footnote: string;
  caption: string;
}

/** Calendar cell colour: green without planned outages, deeper red with more hours. */
function heat(d: ArchiveDayStat): string {
  if (d.kind === 'emergency') return 'rgba(245,158,11,0.75)';
  if (d.kind !== 'planned') return d.kind === 'future' ? C.future : C.unknown;
  const h = d.plannedMs / H;
  return h === 0 ? 'rgba(16,185,129,0.35)' : `rgba(239,68,68,${Math.min(1, 0.25 + h / 14).toFixed(2)})`;
}

function cellLines(d: ArchiveDayStat, t: Dict): string[] {
  const actual = bracket(d.actualMs);
  if (d.kind === 'future') return [];
  if (d.kind === 'nodata') return [t.archive.noData];
  if (d.kind === 'emergency') return [t.archive.emergency, actual].filter(Boolean);
  return [d.plannedMs ? t.archive.hoursShort(num(d.plannedMs)) : '—', actual].filter(Boolean);
}

export function monthArchiveModel(days: ArchiveDayStat[], monthIso: string, group: string | null, _nowMs: number, cfg: Config, t: Dict): MonthArchiveModel {
  const tot = totals(days);
  const first = dt(`${monthIso}-01`, cfg, t);
  const name = first.toFormat('LLLL yyyy');
  const worst = tot.worst ? `${dt(tot.worst.date, cfg, t).toFormat('d MMM')} · ${hrs(tot.worst.ms, t)}` : '—';
  const monday = first.startOf('week');
  return {
    title: t.archive.monthTitle(name),
    subtitle: group ? t.archive.group(group) : '',
    stats: [
      totalStat(t.archive.withoutPower, tot.plannedMs, tot.actualMs, t),
      { label: t.archive.daysWith, value: t.archive.of(tot.daysWithOutages, tot.daysKnown), tone: 'plain' },
      { label: t.archive.worstDay, value: worst, tone: 'plain' },
    ],
    weekdays: Array.from({ length: 7 }, (_, i) => cap(monday.plus({ days: i }).toFormat('ccc'))),
    offset: first.weekday - 1,
    cells: days.map((d) => ({ day: dt(d.date, cfg, t).day, kind: d.kind, lines: cellLines(d, t), fill: heat(d) })),
    footnote: t.archive.footnote,
    caption: `🗓 <b>${t.archive.monthTitle(name)}</b>`,
  };
}

export interface QuarterRow {
  label: string; // week start, dd.MM
  cells: string[]; // 7 day fills, Mon…Sun
  text: string; // planned hours of the week
  sub: string; // (actual), grey
  tone: Tone;
}

export interface QuarterArchiveModel {
  title: string;
  subtitle: string;
  stats: Stat[];
  weekdays: string[];
  rows: QuarterRow[];
  legend: { less: string; more: string; emergency: string; scale: string[]; emergencyFill: string };
  footnote: string;
  caption: string;
}

/** 13 weeks: a row per week, a cell per day (colour = planned hours), planned (actual) per week on the right. */
export function quarterArchiveModel(weeks: ArchiveDayStat[][], group: string | null, _nowMs: number, cfg: Config, t: Dict): QuarterArchiveModel {
  const per = weeks.map((w) => totals(w));
  const all = totals(weeks.flat());
  const tr = trend(per);
  const worst = per.reduce((a, p) => Math.max(a, p.plannedMs), 0);
  const stats: Stat[] = [totalStat(t.archive.withoutPower, all.plannedMs, all.actualMs, t), { label: t.archive.daysWith, value: t.archive.of(all.daysWithOutages, all.daysKnown), tone: 'plain' }];
  if (tr !== null) {
    const pct = Math.round(tr * 100);
    stats.push({ label: t.archive.trend, value: `${pct > 0 ? '↑ +' : pct < 0 ? '↓ −' : ''}${Math.abs(pct)}%`, tone: pct > 0 ? 'red' : pct < 0 ? 'green' : 'plain' });
  } else stats.push({ label: t.archive.worstWeek, value: worst ? hrs(worst, t) : '—', tone: 'plain' });
  const monday = dt(weeks[0]![0]!.date, cfg, t).startOf('week');
  const sample = (h: number): ArchiveDayStat => ({ date: '', kind: 'planned', spans: [], plannedMs: h * H, actualMs: null, dayMs: 24 * H });
  return {
    title: t.archive.quarterTitle,
    subtitle: sub([rangeText(weeks[0]![0]!.date, weeks.at(-1)!.at(-1)!.date, cfg, t), group ? t.archive.group(group) : null]),
    stats,
    weekdays: Array.from({ length: 7 }, (_, i) => cap(monday.plus({ days: i }).toFormat('ccc'))),
    rows: weeks.map((w, i) => {
      const p = per[i]!;
      const known = p.daysKnown > 0;
      return {
        label: dt(w[0]!.date, cfg, t).toFormat('dd.MM'),
        cells: w.map(heat),
        text: known ? num(p.plannedMs) : '—',
        sub: known ? `(${num(p.actualMs)})` : '',
        tone: known ? (p.plannedMs > 0 ? 'red' : 'green') : 'muted',
      };
    }),
    legend: { less: t.archive.less, more: t.archive.more, emergency: t.archive.emergency, scale: [0, 3, 6, 9, 12].map((h) => heat(sample(h))), emergencyFill: heat({ ...sample(0), kind: 'emergency' }) },
    footnote: t.archive.footnote,
    caption: `🗓 <b>${t.archive.quarterTitle}</b>`,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// --- SVG ---------------------------------------------------------------------

const X = 24;
const W = CARD_W - 48;

function header(title: string, subtitle: string, stats: Stat[]): { parts: string[]; y: number } {
  const parts = [`<text x="${X}" y="52" font-size="${fitFont(title, W, 26)}" font-weight="700" fill="${C.text}">${plain(title)}</text>`];
  if (subtitle) parts.push(`<text x="${X}" y="80" font-size="${fitFont(subtitle, W, 14)}" font-weight="500" fill="${C.muted}">${plain(subtitle)}</text>`);
  parts.push(statsRow(122, stats));
  return { parts, y: 196 }; // first free line below the stats values
}

/** Grey "(actual)" after the main value, in the same text run. */
const withSub = (s: string) => (s ? ` <tspan fill="${C.muted}" font-weight="500">${plain(s)}</tspan>` : '');

const footnote = (y: number, text: string) => `<text x="${X}" y="${y}" font-size="${fitFont(text, W, 13)}" font-weight="500" fill="${C.muted}">${plain(text)}</text>`;

const ROW_H = 34;
const LABEL_W = 62;
const TEXT_W = 128;

export function svgArchiveWeek(m: WeekArchiveModel): string {
  const { parts, y: top } = header(m.title, m.subtitle, m.stats);
  const bx = X + LABEL_W;
  const bw = W - LABEL_W - TEXT_W;
  m.rows.forEach((r, i) => {
    const y = top + 14 + i * ROW_H;
    const by = y - 12;
    parts.push(`<text x="${X}" y="${y}" font-size="${fitFont(r.label, LABEL_W - 8, 14)}" font-weight="600" fill="${C.text}">${plain(r.label)}</text>`);
    const base = r.kind === 'planned' ? C.greenDeep : r.kind === 'emergency' ? C.amberDeep : r.kind === 'future' ? C.future : C.unknown;
    parts.push(`<clipPath id="wk${i}"><rect x="${bx}" y="${by}" width="${bw}" height="14" rx="7"/></clipPath><g clip-path="url(#wk${i})">`);
    parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="14" fill="${base}"/>`);
    for (const b of r.bar) parts.push(`<rect x="${(bx + bw * b.x0).toFixed(1)}" y="${by}" width="${Math.max(0.5, bw * (b.x1 - b.x0)).toFixed(1)}" height="14" fill="${C.redDeep}"/>`);
    parts.push('</g>');
    if (r.text) parts.push(`<text x="${X + W}" y="${y}" text-anchor="end" font-size="${fitFont(`${r.text} ${r.sub}`.trim(), TEXT_W - 12, 14)}" font-weight="600" fill="${TONE[r.tone]}">${plain(r.text)}${withSub(r.sub)}</text>`);
  });
  let y = top + 14 + m.rows.length * ROW_H - 8;
  m.ticks.forEach((tk, i) => {
    const x = bx + (bw * i) / (m.ticks.length - 1);
    const anchor = i === 0 ? 'start' : i === m.ticks.length - 1 ? 'end' : 'middle';
    parts.push(`<text x="${x.toFixed(1)}" y="${y}" text-anchor="${anchor}" font-size="11" font-weight="500" fill="${C.dim}">${tk}</text>`);
  });
  y += 28;
  parts.push(footnote(y, m.footnote));
  return frame(y + 24, parts.join('\n'));
}

const GAP = 4;
const MONTH_SUB = 'rgba(226,232,240,0.7)'; // grey that still reads on red cells
const CELL_W = (W - GAP * 6) / 7;
const CELL_H = 58;

export function svgArchiveMonth(m: MonthArchiveModel): string {
  const { parts, y: top } = header(m.title, m.subtitle, m.stats);
  m.weekdays.forEach((d, i) => {
    parts.push(`<text x="${(X + i * (CELL_W + GAP) + CELL_W / 2).toFixed(1)}" y="${top}" text-anchor="middle" font-size="${fitFont(d, CELL_W - 4, 12)}" font-weight="500" fill="${C.muted}">${plain(d)}</text>`);
  });
  const gy = top + 12;
  m.cells.forEach((c, i) => {
    const slot = m.offset + i;
    const x = X + (slot % 7) * (CELL_W + GAP);
    const y = gy + Math.floor(slot / 7) * (CELL_H + GAP);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${CELL_W.toFixed(1)}" height="${CELL_H}" rx="8" fill="${c.fill}"/>`);
    parts.push(`<text x="${(x + 7).toFixed(1)}" y="${y + 18}" font-size="13" font-weight="700" fill="${C.text}">${c.day}</text>`);
    c.lines.forEach((l, j) => {
      const size = j === 0 ? 12 : 11;
      parts.push(`<text x="${(x + 7).toFixed(1)}" y="${y + 35 + j * 14}" font-size="${fitFont(l, CELL_W - 12, size)}" font-weight="${j === 0 ? 600 : 500}" fill="${j === 0 ? C.text : MONTH_SUB}">${plain(l)}</text>`);
    });
  });
  const rows = Math.ceil((m.offset + m.cells.length) / 7);
  const y = gy + rows * (CELL_H + GAP) + 22;
  parts.push(footnote(y, m.footnote));
  return frame(y + 24, parts.join('\n'));
}

const Q_LABEL_W = 52;
const Q_TEXT_W = 96;
const Q_ROW_H = 26;
const Q_GAP = 4;

export function svgArchiveQuarter(m: QuarterArchiveModel): string {
  const { parts, y: top } = header(m.title, m.subtitle, m.stats);
  const gx = X + Q_LABEL_W;
  const gw = W - Q_LABEL_W - Q_TEXT_W;
  const cw = (gw - Q_GAP * 6) / 7;
  m.weekdays.forEach((d, i) => {
    parts.push(`<text x="${(gx + i * (cw + Q_GAP) + cw / 2).toFixed(1)}" y="${top}" text-anchor="middle" font-size="${fitFont(d, cw, 11)}" font-weight="500" fill="${C.muted}">${plain(d)}</text>`);
  });
  m.rows.forEach((r, i) => {
    const y = top + 12 + i * Q_ROW_H;
    parts.push(`<text x="${X}" y="${y + 14}" font-size="11" font-weight="500" fill="${C.muted}">${r.label}</text>`);
    r.cells.forEach((fill, j) => parts.push(`<rect x="${(gx + j * (cw + Q_GAP)).toFixed(1)}" y="${y}" width="${cw.toFixed(1)}" height="${Q_ROW_H - 6}" rx="4" fill="${fill}"/>`));
    const label = `${r.text} ${r.sub}`.trim();
    parts.push(`<text x="${X + W}" y="${y + 14}" text-anchor="end" font-size="${fitFont(label, Q_TEXT_W - 10, 13)}" font-weight="600" fill="${TONE[r.tone]}">${plain(r.text)}${withSub(r.sub)}</text>`);
  });
  let y = top + 12 + m.rows.length * Q_ROW_H + 14;
  // Legend: less ▫▫▫▫▫ more · ▫ emergency
  let x = X;
  parts.push(`<text x="${x}" y="${y + 10}" font-size="11" font-weight="500" fill="${C.muted}">${plain(m.legend.less)}</text>`);
  x += m.legend.less.length * 7.2 + 10;
  for (const f of m.legend.scale) {
    parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="14" height="12" rx="3" fill="${f}"/>`);
    x += 18;
  }
  parts.push(`<text x="${(x + 2).toFixed(1)}" y="${y + 10}" font-size="11" font-weight="500" fill="${C.muted}">${plain(m.legend.more)}</text>`);
  x += m.legend.more.length * 7.2 + 20;
  parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="14" height="12" rx="3" fill="${m.legend.emergencyFill}"/>`);
  parts.push(`<text x="${(x + 20).toFixed(1)}" y="${y + 10}" font-size="11" font-weight="500" fill="${C.muted}">${plain(m.legend.emergency)}</text>`);
  y += 40;
  parts.push(footnote(y, m.footnote));
  return frame(y + 24, parts.join('\n'));
}
