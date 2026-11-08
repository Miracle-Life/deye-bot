import { DateTime } from 'luxon';
import type { InlineKeyboard } from 'grammy';
import type { Config } from '../config.js';
import type { BatteryLimits, Interval, Reading } from '../deye/types.js';
import type { DetectorEvent } from '../domain/detector.js';
import { runtimeHours, timeToFullMin } from '../domain/forecast.js';
import type { GridSample } from '../domain/grid.js';
import { batteryScaleW, batteryV, gridLoad } from '../domain/load.js';
import type { Summary } from '../domain/stats.js';
import type { Dict } from '../i18n/index.js';
import type { TileState } from '../schedule/logic.js';
import { scheduleTile } from '../render/models.js';

export interface Msg {
  text: string;
  silent: boolean;
  photo?: Buffer; // sent as a photo with `text` as the caption
  panel?: true; // deliver the panel card itself (photo, caption, buttons) and keep it live; `text` is the fallback
  kb?: InlineKeyboard; // buttons under whatever is sent
  fallbackText?: string; // sent instead of `text` when the photo can't be sent
}

export interface PanelCtx {
  reading: Reading | null;
  grid: GridSample | null;
  outageStartTs: number | null;
  lastOnTs: number | null; // when grid last came back
  lastOutageStartTs?: number | null; // start of that last outage (caption: "was off 3 h")
  nowMs: number;
  staleAfterMs: number;
  limits: BatteryLimits | null; // inverter settings; null until read
  // null/absent: no address or no data yet. dischargeW: 15-min average (a kettle must not flip the verdict).
  schedule?: { state: TileState; stale: boolean; fetchedAt: number; dischargeW?: number | null } | null;
}

const MIN = 60_000;
const H = 60 * MIN;
const ALL_PHASES = 3;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function socBar(soc: number): string {
  const n = Math.max(0, Math.min(10, Math.round(soc / 10)));
  const cell = soc >= 50 ? '🟩' : soc >= 20 ? '🟨' : '🟥';
  return cell.repeat(n) + '⬜'.repeat(10 - n);
}

export function fmtDuration(ms: number, t: Dict): string {
  const u = t.units;
  const totalMin = Math.max(0, Math.round(ms / MIN));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h ? `${d} ${u.d} ${h} ${u.h}` : `${d} ${u.d}`;
  if (h > 0) return m ? `${h} ${u.h} ${m} ${u.min}` : `${h} ${u.h}`;
  return `${m} ${u.min}`;
}

// Forecasts: hours and minutes below 30 h; from 30 h days + hours plus the total hours in brackets
// ("1 доб 6 год (30 год)"); a week or more "> 7 доб".
export function fmtApproxParts(ms: number, t: Dict): { main: string; hours: string | null } {
  const u = t.units;
  if (ms >= 7 * 24 * H) return { main: `> 7 ${u.d}`, hours: null };
  if (ms >= 30 * H) {
    const h = Math.floor(ms / H);
    const main = h % 24 ? `${Math.floor(h / 24)} ${u.d} ${h % 24} ${u.h}` : `${h / 24} ${u.d}`;
    return { main, hours: `(${h} ${u.h})` };
  }
  // Hours and minutes even past 24 h (fmtDuration would switch to days there).
  const min = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return { main: `${m} ${u.min}`, hours: null };
  return { main: m ? `${h} ${u.h} ${m} ${u.min}` : `${h} ${u.h}`, hours: null };
}

export function fmtApprox(ms: number, t: Dict): string {
  const p = fmtApproxParts(ms, t);
  return p.hours ? `${p.main} ${p.hours}` : p.main;
}

export const fmtTime = (ts: number, zone: string) => DateTime.fromMillis(ts, { zone }).toFormat('HH:mm');
const time = fmtTime;
const watts = (w: number | null, t: Dict) => (w === null ? '—' : `${Math.round(Math.abs(w))} ${t.units.w}`);
/** 8432 → "8.43" (no unit). */
export const fmtKw = (w: number) => (w / 1000).toFixed(2);
/** Bar scale: "10" for whole kW, else "8.47". */
export const fmtKwMax = (w: number) => (fmtKw(w).endsWith('.00') ? String(Math.round(w / 1000)) : fmtKw(w));
export const fmtPower = (w: number, t: Dict) =>
  Math.round(Math.abs(w)) >= 1000 ? `${fmtKw(Math.abs(w))} ${t.units.kw}` : `${Math.round(Math.abs(w))} ${t.units.w}`;
const kw = fmtPower;
const capacity = (r: Reading | null, cfg: Config) => r?.batteryCapacityKwh ?? cfg.batteryCapacityKwh;
const load = (r: Reading) => r.upsLoadPowerW ?? r.loadPowerW;

function when(ts: number, approxFromTs: number | null, zone: string, t: Dict): string {
  return approxFromTs === null ? time(ts, zone) : t.common.between(time(approxFromTs, zone), time(ts, zone));
}

function runtimeText(r: Reading, cfg: Config, t: Dict): string | null {
  const l = load(r);
  if (r.soc === null || l === null) return null;
  const h = runtimeHours(r.soc, l, capacity(r, cfg), cfg.batteryReservePct);
  return h === null ? null : t.events.runtime(fmtApprox(h * H, t));
}

function etaText(r: Reading, cfg: Config, nowMs: number, t: Dict): string | null {
  if (r.soc === null || r.batteryPowerW === null) return null;
  const min = timeToFullMin(r.soc, r.batteryPowerW, capacity(r, cfg));
  if (min === null || min === 0) return null;
  return t.events.eta(fmtDuration(min * MIN, t), time(nowMs + min * MIN, cfg.timezone));
}

function phasesNote(missing: string[], t: Dict): string {
  return missing.length && missing.length < ALL_PHASES ? t.common.missingPhases(missing.join(', ')) : '';
}

/** Outage start/end become the live panel; ones replayed after the bot was down keep their text. */
export function eventMsg(e: DetectorEvent, cfg: Config, t: Dict, replayed: boolean): Msg {
  const m = renderEvent(e, cfg, t);
  if (!m.panel || !replayed) return m;
  const { panel: _, ...rest } = m;
  return rest;
}

export function renderEvent(e: DetectorEvent, cfg: Config, t: Dict): Msg {
  const z = cfg.timezone;
  const ev = t.events;
  switch (e.type) {
    case 'outage_started': {
      const r = e.reading;
      const lines = [`<b>${ev.outageStarted(when(e.ts, e.approxFromTs, z, t))}</b>`, `<blockquote>${ev.onBatteries}`];
      const note = phasesNote(e.missingPhases, t);
      if (note) lines.push(`⚠️ ${note}`);
      const parts = [r.soc !== null ? `🔋 ${Math.round(r.soc)}%` : null, `⚡ ${watts(load(r), t)}`, runtimeText(r, cfg, t)].filter(Boolean);
      lines.push(`${parts.join(' · ')}</blockquote>`);
      return { text: lines.join('\n'), silent: false, panel: true };
    }
    case 'outage_ended': {
      const r = e.reading;
      const lines = [
        `<b>${ev.outageEnded(when(e.ts, e.approxFromTs, z, t))}</b>`,
        `<blockquote>${ev.wasOff(fmtDuration(e.ts - e.startTs, t), time(e.startTs, z), time(e.ts, z))}`,
      ];
      const charging = (r.batteryPowerW ?? 0) > 0;
      if (r.soc !== null) lines.push(`🔋 ${Math.round(r.soc)}%${charging ? ev.chargingNow(kw(r.batteryPowerW!, t)) : ''}`);
      const eta = etaText(r, cfg, e.ts, t);
      if (eta) lines.push(`⏳ ${eta}`);
      lines[lines.length - 1] += '</blockquote>';
      return { text: lines.join('\n'), silent: false, panel: true };
    }
    case 'battery_low': {
      const r = e.reading;
      const lines = [`<b>${ev.batteryLow(e.threshold)}</b>`, `<blockquote>${ev.offFor(fmtDuration(e.ts - e.outageStartTs, t))}`];
      const rt = runtimeText(r, cfg, t);
      lines.push(`${rt ? ev.atCurrentLoad(watts(load(r), t), rt) : ev.socNow(r.soc !== null ? String(Math.round(r.soc)) : '?')}</blockquote>`);
      return { text: lines.join('\n'), silent: false };
    }
    case 'battery_full': {
      const took = e.chargeStartTs !== null ? `\n<i>${ev.chargedFor(fmtDuration(e.ts - e.chargeStartTs, t))}</i>` : '';
      return { text: `<b>${ev.batteryFull}</b>${took}`, silent: true };
    }
    case 'data_stale':
      return { text: `<b>${ev.dataStale(time(e.sinceTs, z))}</b>\n<i>${ev.dataStaleNote}</i>`, silent: true };
    case 'data_resumed':
      return { text: `<b>${ev.dataResumed}</b>\n<i>${ev.gap(fmtDuration(e.ts - e.gapFromTs, t))}</i>`, silent: true };
  }
}

function freshness(c: PanelCtx, z: string, t: Dict): { stale: boolean; line: string } {
  if (!c.reading) return { stale: true, line: `<i>${t.panel.noDataYet}</i>` };
  const age = c.nowMs - c.reading.ts;
  if (age > c.staleAfterMs) return { stale: true, line: `<i>${t.panel.lastDataAt(time(c.reading.ts, z))}</i>` };
  return { stale: false, line: `<i>${t.panel.updatedAgo(Math.max(0, Math.round(age / MIN)))}</i>` };
}

function header(c: PanelCtx, cfg: Config, t: Dict): string {
  const z = cfg.timezone;
  const p = t.panel;
  const lines: string[] = [];
  if (freshness(c, z, t).stale) lines.push(p.noFreshData);
  if (c.grid?.state === 'off') {
    const note = phasesNote(c.grid.missingPhases, t);
    lines.push(`${p.powerOff} · ${note || p.homeOnBatteries}`);
    if (c.outageStartTs !== null) lines.push(`<i>${p.offSince(fmtDuration(c.nowMs - c.outageStartTs, t), time(c.outageStartTs, z))}</i>`);
  } else if (c.grid?.state === 'on') {
    const charging = (c.reading?.batteryPowerW ?? 0) > 0;
    lines.push(`${p.powerOn}${charging ? p.batteriesCharging : ''}`);
    if (c.lastOnTs !== null) lines.push(`<i>${p.backAt(time(c.lastOnTs, z))}</i>`);
  } else {
    lines.push(p.gridUnknown);
  }
  return lines.join('\n');
}

const b = (s: string) => `<b>${s}</b>`;

function batteryBlock(r: Reading, cfg: Config, nowMs: number, t: Dict): string[] {
  const p = t.panel;
  const out: string[] = [];
  if (r.soc !== null) out.push(`🔋 ${b(`${Math.round(r.soc)}%`)}  ${socBar(r.soc)}`);
  const w = r.batteryPowerW;
  if (w !== null && w < 0) {
    const l = load(r);
    const h = r.soc !== null && l !== null ? runtimeHours(r.soc, l, capacity(r, cfg), cfg.batteryReservePct) : null;
    out.push(`${p.discharge(b(kw(w, t)))}${h !== null ? p.runtimeBold(b(fmtApprox(h * H, t))) : ''}`);
  } else if (w !== null && w > 0) {
    const min = r.soc !== null ? timeToFullMin(r.soc, w, capacity(r, cfg)) : null;
    const eta = min ? p.etaBold(b(fmtDuration(min * MIN, t)), time(nowMs + min * MIN, cfg.timezone)) : '';
    out.push(`${p.charge(b(`+${kw(w, t)}`))}${eta}`);
  } else if (w !== null) {
    out.push(p.idle);
  }
  return out;
}

function gridLine(r: Reading, g: GridSample | null, t: Dict): string {
  const p = t.panel;
  const volts = r.gridVoltages.filter((v): v is number => v !== null);
  const avg = volts.length ? Math.round(volts.reduce((x, y) => x + y, 0) / volts.length) : null;
  if (g?.state === 'off') return `${p.gridLine} ${b(p.gridNo)}`;
  if (g?.state === 'on') return `${p.gridLine} ${b(p.gridYes)}${avg !== null ? ` · ${avg} ${t.units.v}` : ''}`;
  return `${p.gridLine} ❔`;
}

const homeLoad = (r: Reading, t: Dict) => (load(r) === null ? '—' : kw(load(r)!, t));

function view(c: PanelCtx, cfg: Config, t: Dict, body: (r: Reading) => string[]): string {
  const parts = [header(c, cfg, t)];
  if (c.reading) parts.push('', ...body(c.reading));
  parts.push('', freshness(c, cfg.timezone, t).line);
  return parts.join('\n');
}

function loadLine(r: Reading, c: PanelCtx, t: Dict): string[] {
  if (c.grid?.state === 'off') {
    const l = load(r);
    const limit = batteryScaleW(c.limits?.dischargeA ?? null, batteryV(r.batteryVoltage), r.ratedPowerW);
    return l !== null ? [t.panel.fromBatteries(b(kw(l, t)), kw(limit, t))] : [];
  }
  const l = gridLoad(r);
  return l ? [t.panel.fromGrid(b(kw(l.totalW, t)), fmtKw(l.homeW), fmtKw(l.batteryW))] : [];
}

function scheduleLine(c: PanelCtx, cfg: Config, t: Dict): string[] {
  const s = scheduleTile(c, cfg, t);
  return s ? [`🗓 ${b(s.title)}${s.lines.length ? ` · ${s.lines.map((l) => l.text).join(' · ')}` : ''}`] : [];
}

export function renderPanel(c: PanelCtx, cfg: Config, t: Dict): string {
  return view(c, cfg, t, (r) => [
    ...batteryBlock(r, cfg, c.nowMs, t),
    ...loadLine(r, c, t),
    ...scheduleLine(c, cfg, t),
    '',
    `${t.panel.consumption} ${b(homeLoad(r, t))}`,
    `${t.panel.sun} ${b(r.pvPowerW === null ? '—' : kw(r.pvPowerW, t))}`,
    gridLine(r, c.grid, t),
  ]);
}

const share = (ms: number, known: number) => (known ? ` · ${Math.round((ms / known) * 100)}%` : '');

/** Splits the hour strip into rows of 12 so it fits a phone screen. */
function stripRows(strip: string): string[] {
  const cells = [...strip];
  return [`00 ${cells.slice(0, 12).join('')}`, `12 ${cells.slice(12).join('')}`];
}

export function renderDay(
  dateIso: string,
  sum: Summary,
  strip: string,
  outages: Interval[],
  min: { soc: number; ts: number } | null,
  kwh: number,
  cfg: Config,
  range: { from: number; to: number },
  nowMs: number,
  dataFromTs: number | null,
  t: Dict,
): string {
  const z = cfg.timezone;
  const s = t.stats;
  const title = DateTime.fromISO(dateIso, { zone: z }).setLocale(t.locale).toFormat('cccc, d MMMM');
  const known = sum.onMs + sum.offMs;
  const out = [`📊 ${b(title.charAt(0).toUpperCase() + title.slice(1))}`];
  if (dataFromTs !== null && dataFromTs > range.from && dataFromTs < range.to) {
    out.push(`<i>${s.dataFrom(DateTime.fromMillis(dataFromTs, { zone: z }).toFormat('dd.MM HH:mm'))}</i>`);
  }
  out.push(
    '',
    `💡 ${s.wasOn} ${b(fmtDuration(sum.onMs, t))}${share(sum.onMs, known)}`,
    `🌑 ${s.wasOff} ${b(fmtDuration(sum.offMs, t))}${share(sum.offMs, known)}`,
  );
  if (sum.unknownMs > 0) out.push(`❔ ${s.noData} ${b(fmtDuration(sum.unknownMs, t))}`);
  out.push(`🔁 ${s.outages} ${b(String(sum.outageCount))}`, '', ...stripRows(strip));
  if (outages.length) {
    const items = outages.map((o) => {
      const end = o.end ?? nowMs;
      return `🌑 ${time(o.start, z)} – ${o.end === null ? t.common.now : time(end, z)} · ${fmtDuration(end - o.start, t)}`;
    });
    out.push(`<blockquote>${items.join('\n')}</blockquote>`);
  }
  const extra = [min ? `🔋 ${s.minSoc(Math.round(min.soc), time(min.ts, z))}` : null, kwh > 0 ? s.fromBatteries(kwh.toFixed(1)) : null]
    .filter(Boolean)
    .join(' · ');
  if (extra) out.push(`<i>${extra}</i>`);
  return out.join('\n');
}

function periodRows(rows: { label: string; sum: Summary }[], t: Dict): string[] {
  const worst = rows.reduce<{ label: string; sum: Summary } | null>((a, r) => (r.sum.offMs > (a?.sum.offMs ?? 0) ? r : a), null);
  return rows.map((r) => {
    const s = r.sum;
    let text: string;
    if (s.onMs + s.offMs === 0) text = `❔ ${t.stats.rowNoData}`;
    else if (s.offMs === 0) text = `💡 ${t.stats.rowAllDay}`;
    else text = `🌑 ${fmtDuration(s.offMs, t)} · ${t.stats.outagesShort(s.outageCount)}`;
    return `${b(r.label)}  ${text}${worst === r && rows.length > 1 ? '  🔻' : ''}`;
  });
}

function totals(total: Summary, cfg: Config, t: Dict): string[] {
  const s = t.stats;
  const lines: string[] = [];
  const known = total.onMs + total.offMs;
  if (known) lines.push(s.onShareOfTime(b(`${Math.round((total.onMs / known) * 100)}%`)));
  if (total.offMs) lines.push(`🌑 ${s.withoutPower} ${b(fmtDuration(total.offMs, t))} · ${s.outagesShort(total.outageCount)}`);
  if (total.longestOutage) {
    const d = DateTime.fromMillis(total.longestOutage.start, { zone: cfg.timezone }).setLocale(t.locale);
    lines.push(`⏱ ${s.longest(fmtDuration(total.longestOutage.ms, t), d.toFormat('ccc'), d.toFormat('HH:mm'))}`);
  }
  if (total.unknownMs > 0) lines.push(`❔ ${s.noDataColon(fmtDuration(total.unknownMs, t))}`);
  return lines;
}

function periodText(title: string, rows: { label: string; sum: Summary }[], q: string[], t: Dict): string {
  return [title, '', ...periodRows(rows, t), ...(q.length ? ['', `<blockquote>${q.join('\n')}</blockquote>`] : [])].join('\n');
}

export function renderWeek(rangeLabel: string, rows: { label: string; sum: Summary }[], total: Summary, prevTotal: Summary | null, cfg: Config, t: Dict): string {
  const q = totals(total, cfg, t);
  if (prevTotal) {
    const diff = total.outageCount - prevTotal.outageCount;
    q.push(diff === 0 ? t.stats.sameAsLastWeek : t.stats.vsLastWeek(Math.abs(diff), diff < 0));
  }
  return periodText(`📅 ${b(rangeLabel)}`, rows, q, t);
}

export function renderMonth(rangeLabel: string, rows: { label: string; sum: Summary }[], total: Summary, cfg: Config, t: Dict): string {
  return periodText(`🗓 ${b(rangeLabel)}`, rows, totals(total, cfg, t), t);
}

export function renderAccessRequest(name: string, username: string | null, t: Dict): string {
  return `👤 <b>${esc(name)}</b>${username ? ` (@${esc(username)})` : ''} ${t.panel.accessRequest}`;
}
