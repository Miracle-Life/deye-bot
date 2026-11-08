// Pure view-models for the image cards: what to show, already formatted.
import { DateTime } from 'luxon';
import { fmtApprox, fmtDuration, fmtKw, fmtKwMax, fmtPower, fmtTime, type PanelCtx } from '../bot/format.js';
import type { Dict } from '../i18n/index.js';
import { batteryVerdict, socAt, type TileState } from '../schedule/logic.js';
import type { Schedule } from '../schedule/model.js';
import type { Config } from '../config.js';
import type { Interval, Reading } from '../deye/types.js';
import { runtimeHours, timeToFullMin } from '../domain/forecast.js';
import type { EnergyDay, MonthSummary, Tariff } from '../domain/energy.js';
import type { Segment, Summary } from '../domain/stats.js';
import { batteryBands, batteryScaleW, batteryZone, GRID_ORANGE_W, GRID_YELLOW_W, gridChargeW, gridLoad, gridScaleW, loadZone, batteryV, BATTERY_IDLE_W, runtimeColor, type LoadZone } from '../domain/load.js';

export type Tone = 'green' | 'red' | 'amber' | 'plain' | 'muted';
export type Icon = 'home' | 'sun' | 'grid' | 'battery' | 'moon' | 'calendar';

export interface Tile {
  icon: Icon;
  label: string;
  value: string;
  unit: string;
  tone?: Tone;
}

export interface PanelModel {
  status: { kind: 'on' | 'off' | 'unknown'; label: string };
  time: string | null;
  stale: string | null;
  soc: number | null;
  socKwh: string | null;
  flow: { label: string; value: string } | null;
  eta: { label: string; value: string; tone: Tone; color?: string } | null; // color: overrides tone (runtime scale)
  load: LoadBlock | null;
  schedule: ScheduleTile | null;
  tiles: Tile[];
  caption: string;
}

export interface LoadBlock {
  label: string;
  value: string; // kW
  max: string;
  zone: LoadZone;
  scale: { yellow: number; orange: number; red: number }; // bar fractions where each zone starts
  homeFrac: number; // of the bar's full scale
  batteryFrac: number;
  legend: { home: { label: string; kw: string }; battery: { label: string; kw: string } | null; limit: string | null };
}

export interface ScheduleTile {
  label: string;
  title: string;
  tone: Tone;
  lines: { text: string; tone: Tone }[];
}

export interface Stat {
  label: string;
  value: string;
  sub?: string; // grey addition after the value, e.g. "(32)"
  tone: Tone;
}

export interface DayModel {
  title: string;
  subtitle: string | null;
  stats: Stat[];
  unknown: string | null;
  bar: { x0: number; x1: number; state: Segment['state'] | 'future' }[];
  ticks: { x: number; label: string }[];
  outages: string[];
  more: number;
  footer: string | null;
  caption: string;
  labels: { outages: string; more: string };
}

export interface PeriodModel {
  title: string;
  rows: { label: string; on: number; off: number; unknown: number; text: string; tone: Tone; worst: boolean }[];
  stats: Stat[];
  notes: string[];
  caption: string;
}

const MIN = 60_000;
const H = 60 * MIN;
const MAX_OUTAGE_LINES = 5;

function split(w: number | null, t: Dict): { value: string; unit: string } {
  if (w === null) return { value: '—', unit: '' };
  const [value, unit] = fmtPower(w, t).split(' ');
  return { value: value!, unit: unit ?? '' };
}

const load = (r: Reading) => r.upsLoadPowerW ?? r.loadPowerW;
const cap = (r: Reading, cfg: Config) => r.batteryCapacityKwh ?? cfg.batteryCapacityKwh;

const frac = (w: number, of: number) => (of > 0 ? Math.round((Math.min(Math.max(w, 0), of) / of) * 10_000) / 10_000 : 0);

function gridBlock(r: Reading, cfg: Config, t: Dict): LoadBlock | null {
  const l = gridLoad(r);
  if (!l) return null;
  const scaleW = gridScaleW(r.ratedPowerW);
  const redW = cfg.gridLoadMaxKw * 1000;
  const homeFrac = frac(l.homeW, scaleW);
  const red = frac(redW, scaleW);
  return {
    label: t.card.fromGrid,
    value: fmtKw(l.totalW),
    max: `${fmtKwMax(scaleW)} ${t.units.kw}`,
    zone: loadZone(l.totalW, redW),
    scale: { yellow: Math.min(frac(GRID_YELLOW_W, scaleW), red), orange: Math.min(frac(GRID_ORANGE_W, scaleW), red), red },
    homeFrac,
    batteryFrac: Math.min(frac(l.batteryW, scaleW), 1 - homeFrac),
    legend: {
      home: { label: t.card.loadHome, kw: fmtKw(l.homeW) },
      battery: { label: t.card.loadBatteries, kw: fmtKw(l.batteryW) },
      limit: t.card.chargeLimit(cfg.gridChargeA, fmtKw(gridChargeW(cfg.gridChargeA, batteryV(r.batteryVoltage)))),
    },
  };
}

/** During an outage: house draw against what the inverter can give from the batteries. */
function batteryBlock(r: Reading, dischargeA: number | null, cfg: Config, t: Dict): LoadBlock | null {
  const w = load(r);
  if (w === null) return null;
  const scaleW = batteryScaleW(dischargeA, batteryV(r.batteryVoltage), r.ratedPowerW);
  const redW = cfg.batteryLoadMaxKw * 1000;
  return {
    label: t.card.fromBatteries,
    value: fmtKw(w),
    max: `${fmtKwMax(scaleW)} ${t.units.kw}`,
    zone: batteryZone(w, scaleW, redW),
    scale: batteryBands(scaleW, redW),
    homeFrac: frac(w, scaleW),
    batteryFrac: 0,
    legend: {
      home: { label: t.card.loadHome, kw: fmtKw(w) },
      battery: null,
      limit: t.card.dischargeLimit(dischargeA, fmtKwMax(scaleW), r.ratedPowerW === null ? null : fmtKwMax(r.ratedPowerW)),
    },
  };
}

/** Span ends at local midnight read as 24:00, not 00:00. */
function endTime(ts: number, z: string): string {
  return DateTime.fromMillis(ts, { zone: z }).startOf('day').toMillis() === ts ? '24:00' : fmtTime(ts, z);
}

export function scheduleTile(c: PanelCtx, cfg: Config, t: Dict): ScheduleTile | null {
  if (!c.schedule) return null;
  const z = cfg.timezone;
  const k = t.sched;
  const now = c.nowMs;
  const r = c.reading;
  const inDur = (ts: number) => fmtDuration(Math.max(0, ts - now), t);
  // "tomorrow" only when it adds information (an overnight 06:00 is clear from "in 9 h").
  const when = (ts: number) => (ts - now > 12 * H && DateTime.fromMillis(ts, { zone: z }).toISODate() !== DateTime.fromMillis(now, { zone: z }).toISODate() ? k.tomorrowAt(fmtTime(ts, z)) : fmtTime(ts, z));
  const lines: ScheduleTile['lines'] = [];
  let title: string;
  let tone: Tone = 'plain';
  const st = c.schedule.state;
  switch (st.kind) {
    case 'off-until': {
      if (st.until <= now) {
        // Within the grace after the scheduled power-on: it's running late, not "in 0 min".
        title = k.late(fmtTime(st.until, z));
        tone = 'amber';
        lines.push({ text: k.lateNote, tone: 'amber' });
        break;
      }
      title = st.endsAtDayEdge ? k.untilEdge(endTime(st.until, z), inDur(st.until)) : k.powerAt(when(st.until), inDur(st.until));
      if (st.endsAtDayEdge) lines.push({ text: k.tomorrowUnpublished, tone: 'muted' });
      const discharge = c.schedule.dischargeW ?? (r?.batteryPowerW != null && r.batteryPowerW < 0 ? -r.batteryPowerW : 0);
      // No verdict against a 24:00 edge: the real power-on time is unknown.
      if (r?.soc != null && discharge > 0 && !st.endsAtDayEdge) {
        const v = batteryVerdict(r.soc, discharge, Math.max(0, r.pvPowerW ?? 0), now, st.until, { capacityKwh: cap(r, cfg), reservePct: cfg.batteryReservePct });
        lines.push(v.ok ? { text: k.enough, tone: 'green' } : { text: k.notEnough(fmtTime(v.endsAt, z), fmtPower(v.adviseLoadW, t)), tone: 'red' });
      }
      break;
    }
    case 'off-late':
      title = k.late(fmtTime(st.due, z));
      tone = 'amber';
      lines.push({ text: k.lateNote, tone: 'amber' });
      break;
    case 'off-unscheduled':
      title = k.unscheduled;
      tone = 'red';
      break;
    case 'emergency':
      title = k.emergency;
      tone = 'red';
      lines.push({ text: k.emergencyNote, tone: 'muted' });
      break;
    case 'today-unpublished':
      title = k.todayUnpublished;
      tone = 'muted';
      break;
    case 'on-in-slot':
      if (st.early) {
        title = k.backEarly;
        tone = 'green';
        lines.push({ text: k.backEarlyNote(endTime(st.until, z)), tone: 'amber' });
      } else {
        title = k.inSlot(fmtTime(st.from, z));
        tone = 'amber';
        lines.push({ text: k.inSlotNote(endTime(st.until, z)), tone: 'muted' });
      }
      break;
    case 'next': {
      title = k.next(when(st.start), inDur(st.start));
      const charging = r?.soc != null && (r.batteryPowerW ?? 0) > 0;
      const soc = charging ? k.socAtOutage(socAt(r!.soc!, r!.batteryPowerW!, cap(r!, cfg), now, st.start)) : null;
      lines.push({ text: [k.nextUntil(endTime(st.end, z)), soc].filter(Boolean).join(' · '), tone: 'muted' });
      break;
    }
    case 'none-today':
      title = k.none;
      tone = 'green';
      lines.push({ text: k.preliminary, tone: 'amber' });
      break;
  }
  if (c.schedule.stale) lines.push({ text: k.stale(fmtTime(c.schedule.fetchedAt, z)), tone: 'amber' });
  return { label: k.label, title, tone, lines };
}

const WAS_OFF_SHOWN_MS = 60 * 60_000;

/** First hour after the power is back: how long it was off. */
function wasOff(c: PanelCtx, t: Dict): string {
  if (c.lastOnTs === null || c.lastOutageStartTs == null || c.nowMs - c.lastOnTs >= WAS_OFF_SHOWN_MS) return '';
  return t.panel.wasOffFor(fmtDuration(c.lastOnTs - c.lastOutageStartTs, t));
}

export function panelModel(c: PanelCtx, cfg: Config, t: Dict): PanelModel {
  const z = cfg.timezone;
  const r = c.reading;
  const g = c.grid?.state ?? null;
  const k = t.card;

  const status: PanelModel['status'] =
    g === 'off'
      ? {
          kind: 'off',
          label: c.outageStartTs !== null ? `${k.statusOff} · ${c.nowMs - c.outageStartTs < MIN ? t.common.justNow : fmtDuration(c.nowMs - c.outageStartTs, t)}` : k.statusOff,
        }
      : g === 'on'
        ? { kind: 'on', label: k.statusOn }
        : { kind: 'unknown', label: k.statusUnknown };

  const stale = !r ? k.noDataYet : c.nowMs - r.ts > c.staleAfterMs ? k.staleSince(fmtTime(r.ts, z)) : null;

  let flow: PanelModel['flow'] = null;
  let eta: PanelModel['eta'] = null;
  if (r?.batteryPowerW != null) {
    const p = r.batteryPowerW;
    const house = load(r);
    const hours = r.soc !== null && house !== null ? runtimeHours(r.soc, house, cap(r, cfg), cfg.batteryReservePct) : null;
    if (g === 'on' && Math.abs(p) < BATTERY_IDLE_W && house !== null && r.soc !== null) {
      // Batteries just wait: what the house takes from the grid, and how long they'd last at that load.
      flow = { label: k.fromGridNow, value: fmtPower(house, t) };
      if (hours !== null) {
        const label = r.soc >= 99 ? k.reserveFull(fmtPower(house, t)) : k.reserveAt(Math.round(r.soc), fmtPower(house, t));
        const approx = fmtApprox(hours * H, t);
        eta = { label, value: approx.startsWith('>') ? approx : `≈ ${approx}`, tone: 'green', color: runtimeColor(hours) };
      }
    } else if (p < 0) {
      flow = { label: k.discharge, value: fmtPower(p, t) };
      if (hours !== null) eta = { label: k.runtime, value: fmtApprox(hours * H, t), tone: 'amber', color: runtimeColor(hours) };
    } else if (p > 0) {
      flow = { label: k.charge, value: `+${fmtPower(p, t)}` };
      const m = r.soc !== null ? timeToFullMin(r.soc, p, cap(r, cfg)) : null;
      if (m) eta = { label: k.toFull, value: fmtDuration(m * MIN, t), tone: 'green' };
    } else {
      flow = { label: k.battery, value: k.idle };
    }
  }

  const tiles: Tile[] = [];
  if (r) {
    tiles.push({ icon: 'home', label: k.home, ...split(load(r), t) });
    tiles.push({ icon: 'sun', label: k.sun, ...split(r.pvPowerW, t) });
    const volts = r.gridVoltages.filter((v): v is number => v !== null);
    const missing = c.grid?.missingPhases ?? [];
    if (g === 'off') {
      tiles.push({ icon: 'grid', label: k.grid, value: k.gridNo, unit: missing.length && missing.length < 3 ? t.common.missingPhases(missing.join(', ')) : '', tone: 'red' });
    } else if (g === 'on') {
      const avg = volts.length ? String(Math.round(volts.reduce((a, b) => a + b, 0) / volts.length)) : k.gridYes;
      tiles.push({ icon: 'grid', label: k.grid, value: avg, unit: volts.length ? t.units.v : '', tone: 'green' });
    } else {
      tiles.push({ icon: 'grid', label: k.grid, value: '?', unit: '' });
    }
    const temp = r.batteryTempC !== null ? ` · ${Math.round(r.batteryTempC)}°C` : '';
    tiles.push({ icon: 'battery', label: k.battery, value: r.batteryVoltage !== null ? r.batteryVoltage.toFixed(1) : '—', unit: `${t.units.v}${temp}` });
  }

  const charging = (r?.batteryPowerW ?? 0) > 0;
  let caption =
    g === 'off'
      ? `${t.panel.powerOff}${c.outageStartTs !== null ? k.captionOffSince(fmtTime(c.outageStartTs, z)) : ''}`
      : g === 'on'
        ? `${t.panel.powerOn}${wasOff(c, t)}${charging ? t.panel.batteriesCharging : ''}`
        : t.panel.gridUnknown;
  if (stale) caption += `\n⚠️ ${stale}`;

  return {
    status,
    time: r ? k.measured(fmtTime(r.ts, z)) : null,
    stale,
    soc: r?.soc ?? null,
    socKwh: r?.soc != null ? `${((r.soc / 100) * cap(r, cfg)).toFixed(1)} ${t.units.kwh}` : null,
    flow,
    eta,
    schedule: scheduleTile(c, cfg, t),
    load: !r ? null : g === 'off' ? batteryBlock(r, c.limits?.dischargeA ?? null, cfg, t) : gridBlock(r, cfg, t),
    tiles,
    caption,
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function dayModel(
  dateIso: string,
  segs: Segment[],
  sum: Summary,
  outages: Interval[],
  min: { soc: number; ts: number } | null,
  kwh: number,
  cfg: Config,
  range: { from: number; to: number },
  nowMs: number,
  dataFromTs: number | null,
  t: Dict,
): DayModel {
  const z = cfg.timezone;
  const st = t.stats;
  const len = range.to - range.from;
  const fx = (ts: number) => Math.round(((ts - range.from) / len) * 10_000) / 10_000;
  const bar: DayModel['bar'] = segs.map((s) => ({ x0: fx(s.start), x1: fx(s.end), state: s.state }));
  const lastEnd = segs.length ? segs[segs.length - 1]!.end : range.from;
  if (lastEnd < range.to) bar.push({ x0: fx(lastEnd), x1: 1, state: 'future' });

  // Local hours: DST days are 23 or 25 hours long.
  const dayStart = DateTime.fromMillis(range.from, { zone: z });
  const ticks = [0, 6, 12, 18].map((h) => ({ x: fx(dayStart.set({ hour: h }).toMillis()), label: String(h).padStart(2, '0') }));
  ticks.push({ x: 1, label: '24' });

  const lines = outages.map((o) => {
    const end = o.end ?? nowMs;
    return `${fmtTime(o.start, z)} – ${o.end === null ? t.common.now : fmtTime(end, z)} · ${fmtDuration(end - o.start, t)}`;
  });

  const title = capitalize(DateTime.fromISO(dateIso, { zone: z }).setLocale(t.locale).toFormat('cccc, d MMMM'));
  const footer = [min ? st.minSocCard(Math.round(min.soc), fmtTime(min.ts, z)) : null, kwh > 0 ? st.fromBatteries(kwh.toFixed(1)) : null]
    .filter(Boolean)
    .join(' · ');
  const more = Math.max(0, lines.length - MAX_OUTAGE_LINES);

  return {
    title,
    subtitle:
      dataFromTs !== null && dataFromTs > range.from && dataFromTs < range.to
        ? st.dataFrom(DateTime.fromMillis(dataFromTs, { zone: z }).toFormat('dd.MM HH:mm'))
        : null,
    stats: [
      { label: st.wasOn, value: fmtDuration(sum.onMs, t), tone: 'green' },
      { label: st.wasOff, value: fmtDuration(sum.offMs, t), tone: 'red' },
      { label: st.outages, value: String(sum.outageCount), tone: 'plain' },
    ],
    unknown: sum.unknownMs > 0 ? `${st.noData} ${fmtDuration(sum.unknownMs, t)}` : null,
    bar,
    ticks,
    outages: lines.slice(0, MAX_OUTAGE_LINES),
    more,
    footer: footer || null,
    caption: `📊 <b>${title}</b>`,
    labels: { outages: st.outagesHeading, more: st.more(more) },
  };
}

export interface PeriodRow {
  label: string;
  sum: Summary;
  spanMs?: number; // full length of the period row (partial days render shorter)
}

export function periodModel(title: string, rows: PeriodRow[], total: Summary, prev: Summary | null, cfg: Config, t: Dict): PeriodModel {
  const st = t.stats;
  const worst = rows.reduce<PeriodRow | null>((a, r) => (r.sum.offMs > (a?.sum.offMs ?? 0) ? r : a), null);
  const out: PeriodModel['rows'] = rows.map((r) => {
    const s = r.sum;
    const all = r.spanMs ?? s.onMs + s.offMs + s.unknownMs;
    const frac = (ms: number) => (all ? Math.round((ms / all) * 10_000) / 10_000 : 0);
    const known = s.onMs + s.offMs;
    const [text, tone]: [string, Tone] = known === 0 ? [st.rowNoData, 'muted'] : s.offMs === 0 ? [st.rowAllDay, 'green'] : [fmtDuration(s.offMs, t), 'red'];
    return { label: r.label, on: frac(s.onMs), off: frac(s.offMs), unknown: frac(s.unknownMs), text, tone, worst: worst === r && rows.length > 1 };
  });

  const known = total.onMs + total.offMs;
  const notes: string[] = [];
  if (total.longestOutage) {
    const d = DateTime.fromMillis(total.longestOutage.start, { zone: cfg.timezone }).setLocale(t.locale);
    notes.push(st.longest(fmtDuration(total.longestOutage.ms, t), d.toFormat('ccc'), d.toFormat('HH:mm')));
  }
  if (prev) {
    const diff = total.outageCount - prev.outageCount;
    notes.push(diff === 0 ? st.sameAsWeekBefore : st.vsWeekBefore(Math.abs(diff), diff < 0));
  }
  if (total.unknownMs > 0) notes.push(st.noDataColon(fmtDuration(total.unknownMs, t)));

  return {
    title,
    rows: out,
    stats: [
      { label: st.wasOn, value: known ? `${Math.round((total.onMs / known) * 100)}%` : '—', tone: 'green' },
      { label: st.withoutPower, value: fmtDuration(total.offMs, t), tone: 'red' },
      { label: st.outages, value: String(total.outageCount), tone: 'plain' },
    ],
    notes,
    caption: `📅 <b>${title}</b>`,
  };
}

export interface MoneyModel {
  title: string;
  total: string;
  totalSub: string;
  forecast: string | null;
  tiles: Tile[];
  bars: { day: number; night: number; today: boolean; label: string | null }[]; // fractions of the tallest day
  stats: Stat[];
  notes: string[];
  caption: string;
  labels: { heading: string; spent: string; forecast: string; byDay: string; day: string; night: string };
}

/** 96.40 ₴ / 1 450 ₴ */
export function fmtUah(n: number): string {
  if (Math.abs(n) < 1000) return `${n.toFixed(2)} ₴`;
  return `${Math.round(n).toLocaleString('en-US').replace(/,/g, ' ')} ₴`;
}

export function moneyModel(s: MonthSummary, monthIso: string, tariff: Tariff, days: EnergyDay[], nowMs: number, cfg: Config, t: Dict): MoneyModel {
  const z = cfg.timezone;
  const mo = t.money;
  const kwh = (n: number) => `${n.toFixed(1)} ${t.units.kwh}`;
  const start = DateTime.fromISO(`${monthIso}-01`, { zone: z }).setLocale(t.locale);
  const n = start.daysInMonth!;
  const todayIso = DateTime.fromMillis(nowMs, { zone: z }).toISODate();
  const byDate = new Map(s.perDay.map((d) => [d.date, d]));
  const max = Math.max(0.01, ...s.perDay.map((d) => d.dayCost + d.nightCost));
  const bars = Array.from({ length: n }, (_, i) => {
    const iso = start.plus({ days: i }).toISODate()!;
    const d = byDate.get(iso);
    const r = (v: number) => Math.round((v / max) * 10_000) / 10_000;
    return { day: d ? r(d.dayCost) : 0, night: d ? r(d.nightCost) : 0, today: iso === todayIso, label: [1, 8, 15, 22, 29].includes(i + 1) ? String(i + 1) : null };
  });

  const purchased = s.dayKwh + s.nightKwh;
  const tiles: Tile[] =
    tariff.nightPrice === null
      ? [{ icon: 'grid', label: mo.grid(tariff.dayPrice.toFixed(2)), value: s.dayCost.toFixed(2), unit: `₴ · ${kwh(s.dayKwh)}` }]
      : [
          { icon: 'sun', label: mo.day(tariff.dayPrice.toFixed(2)), value: s.dayCost.toFixed(2), unit: `₴ · ${kwh(s.dayKwh)}` },
          { icon: 'moon', label: mo.night(tariff.nightPrice.toFixed(2)), value: s.nightCost.toFixed(2), unit: `₴ · ${kwh(s.nightKwh)}` },
        ];

  const notes: string[] = [];
  if (tariff.nightPrice !== null && s.savedByNight > 0) notes.push(mo.nightSaved(fmtUah(s.savedByNight)));
  // Today is still running: averaging it in would pull the figure down.
  const done = s.perDay.filter((d) => d.date !== todayIso);
  if (done.length > 1) notes.push(mo.avgPerDay(fmtUah(done.reduce((a, d) => a + d.dayCost + d.nightCost, 0) / done.length)));
  const today = days.find((d) => d.date === todayIso);
  if (today) {
    const c = today.dayKwh * tariff.dayPrice + today.nightKwh * (tariff.nightPrice ?? tariff.dayPrice);
    notes.push(mo.today(fmtUah(c), kwh(today.dayKwh + today.nightKwh)));
  }

  const title = capitalize(start.toFormat('LLLL yyyy'));
  return {
    title,
    total: fmtUah(s.cost),
    totalSub: mo.fromGrid(kwh(purchased)),
    forecast: s.forecast !== null ? `≈ ${fmtUah(s.forecast)}` : null,
    tiles,
    bars,
    stats: [
      { label: mo.homeUsed, value: kwh(s.consumption), tone: 'plain' },
      { label: mo.fromBatteries, value: kwh(s.discharge), tone: 'plain' },
      { label: mo.sun, value: kwh(s.pv), tone: 'amber' },
    ],
    notes,
    caption: mo.caption(title),
    labels: { heading: mo.heading, spent: mo.spent, forecast: mo.forecast, byDay: mo.byDay, day: mo.dayLegend, night: mo.nightLegend },
  };
}

export interface ScheduleCardModel {
  title: string;
  updated: string;
  stale: string | null;
  days: { title: string; total: string; totalTone: Tone; spans: string | null; bar: { x0: number; x1: number }[]; nowX: number | null; ticks: { x: number; label: string }[]; published: boolean }[];
  status: ScheduleTile;
  caption: string;
}

/** The /schedule card: today and tomorrow as 0–24 bars, plus what it means right now. */
export function scheduleModel(s: Schedule, state: TileState, stale: boolean, nowMs: number, cfg: Config, t: Dict): ScheduleCardModel {
  const z = cfg.timezone;
  const k = t.sched;
  const todayIso = DateTime.fromMillis(nowMs, { zone: z }).toISODate()!;
  // By date, not position: after midnight (before the next poll) yesterday is still in the data.
  const days = s.days.filter((d) => d.date >= todayIso).map((d) => {
    const start = DateTime.fromISO(d.date, { zone: z }).startOf('day');
    const from = start.toMillis();
    const len = start.plus({ days: 1 }).toMillis() - from; // 23/25 h on DST days
    const fx = (ms: number) => Math.round((Math.min(Math.max(ms - from, 0), len) / len) * 10_000) / 10_000;
    const published = d.status === 'applies';
    const off = published ? d.outages.reduce((a, o) => a + o.end - o.start, 0) : 0;
    const [total, totalTone]: [string, Tone] =
      d.status === 'emergency' ? [k.emergencyDay, 'red'] : !published ? [k.unpublished, 'muted'] : off ? [k.hoursOff(fmtDuration(off, t)), 'red'] : [k.noOutages, 'green'];
    return {
      title: k.dayTitle(d.date === todayIso ? k.today : k.tomorrow, start.setLocale(t.locale).toFormat('ccc d')),
      total,
      totalTone,
      spans: published && d.outages.length ? d.outages.map((o) => `${fmtTime(o.start, z)} – ${endTime(o.end, z)}`).join(' · ') : null,
      bar: published ? d.outages.map((o) => ({ x0: fx(o.start), x1: fx(o.end) })) : [],
      nowX: nowMs >= from && nowMs < from + len ? fx(nowMs) : null,
      ticks: [...[0, 6, 12, 18].map((h) => ({ x: fx(start.set({ hour: h }).toMillis()), label: String(h).padStart(2, '0') })), { x: 1, label: '24' }],
      published,
    };
  });
  const status = scheduleTile({ schedule: { state, stale: false, fetchedAt: s.fetchedAt }, reading: null, grid: null, outageStartTs: null, lastOnTs: null, nowMs, staleAfterMs: 0, limits: null }, cfg, t)!;
  const title = k.cardTitle(s.group);
  const caption = [`🗓 <b>${title}</b>`, ...days.map((d) => `<b>${d.title}</b>: ${d.spans ?? d.total}`)].join('\n');
  return {
    title,
    updated: k.updated(fmtTime(s.updatedAt ?? s.fetchedAt, z)),
    stale: stale ? k.stale(fmtTime(s.fetchedAt, z)) : null,
    days,
    status,
    caption,
  };
}

export interface BatteryHealthData {
  nominalKwh: number;
  capacity: { estimateKwh: number | null; pct: number | null; trendPct: number | null };
  cycles: number;
  ratedCycles: number;
  wear: { byCyclesPct: number; byCapacityPct: number | null };
  tempNow: number | null;
  tempMax30: number | null;
  hoursAbove35: number;
  hoursAboveLimit: number;
  limitC: number;
  today: string; // yyyy-mm-dd: the chart's right edge
  days: { date: string; maxTempC: number | null }[]; // last 30, oldest first
}

export interface BatteryCardModel {
  title: string;
  subtitle: string;
  tiles: { label: string; value: string; note: string; tone: Tone }[];
  bars: { x: number; h: number; tone: Tone }[]; // x: slot start 0..1 (30 slots, newest right), h: 0..1 of 0–60 °C
  slotW: number; // one slot as a fraction of the chart width
  marks: { y: number; label: string }[]; // 35 °C and the limit
  chart: string;
  caption: string;
}

const CHART_MAX_C = 60;
const CHART_DAYS = 30; // fixed slots: a fresh install shows narrow bars on the right, not one wide bar

/** /battery card. Everything is an estimate and says so. */
export function batteryModel(d: BatteryHealthData, t: Dict): BatteryCardModel {
  const b = t.battery;
  const c = d.capacity;
  const deg = (v: number | null) => (v === null ? '—' : `${Math.round(v)}°C`);
  const capacity =
    c.estimateKwh === null || c.pct === null
      ? { label: b.capacity, value: '—', note: b.noData, tone: 'muted' as Tone }
      : {
          label: b.capacity,
          value: b.capacityValue(c.estimateKwh.toFixed(1)),
          note: [b.capacityNote(c.pct, d.nominalKwh.toFixed(1)), c.trendPct === null ? null : b.trend(c.trendPct < 0 ? '−' : '+', Math.abs(c.trendPct).toFixed(1))].filter(Boolean).join(' · '),
          tone: (c.pct >= 90 ? 'green' : c.pct >= 80 ? 'amber' : 'red') as Tone,
        };
  const hours = (h: number) => fmtDuration(h * H, t);
  // Colour = how it is now; the 30-day history is in the note and the chart.
  const tone: Tone = d.tempNow === null ? 'muted' : d.tempNow >= d.limitC ? 'red' : d.tempNow > 35 ? 'amber' : 'plain';
  const end = DateTime.fromISO(d.today);
  const slotOf = (date: string) => CHART_DAYS - 1 - Math.round(end.diff(DateTime.fromISO(date), 'days').days);
  return {
    title: b.title,
    subtitle: b.subtitle,
    tiles: [
      capacity,
      { label: b.cycles, value: `≈ ${Math.round(d.cycles)}`, note: b.cyclesNote(d.ratedCycles), tone: 'plain' },
      { label: b.wear, value: `≈ ${d.wear.byCyclesPct.toFixed(1)} %`, note: [b.byCycles, d.wear.byCapacityPct === null ? null : b.byCapacity(d.wear.byCapacityPct.toFixed(1))].filter(Boolean).join(' · '), tone: 'plain' },
      {
        label: b.temp,
        value: deg(d.tempNow),
        note: [b.tempNote(deg(d.tempMax30), hours(d.hoursAbove35)), d.hoursAboveLimit > 0 ? b.aboveLimit(d.limitC, hours(d.hoursAboveLimit)) : null].filter(Boolean).join(' · '),
        tone,
      },
    ],
    slotW: 1 / CHART_DAYS,
    // By date, so days without data (bot or NAS down) stay empty instead of shifting the rest.
    bars: d.days.filter((x) => slotOf(x.date) >= 0 && slotOf(x.date) < CHART_DAYS).map((x) => ({
      x: slotOf(x.date) / CHART_DAYS,
      h: x.maxTempC === null ? 0 : Math.min(1, Math.max(0, x.maxTempC) / CHART_MAX_C),
      tone: x.maxTempC === null ? 'muted' : x.maxTempC >= d.limitC ? 'red' : x.maxTempC > 35 ? 'amber' : 'green',
    })),
    marks: [
      { y: 35 / CHART_MAX_C, label: '35°C' },
      { y: Math.min(1, d.limitC / CHART_MAX_C), label: `${d.limitC}°C` },
    ],
    chart: b.chart,
    caption: b.caption,
  };
}
