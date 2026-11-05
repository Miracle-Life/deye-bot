// Texts for technical notifications and /status.
import { DateTime } from 'luxon';
import type { CloudEvent } from '../domain/ops.js';
import type { WatchEvent } from '../domain/watch.js';
import { BREAKER_W } from '../domain/load.js';
import type { Dict } from '../i18n/index.js';
import { esc, fmtDuration, fmtPower, fmtTime, type Msg } from './format.js';

const round10 = (w: number) => Math.round(w / 10) * 10;
const kw1 = (w: number) => (w / 1000).toFixed(1);

export function renderWatch(e: WatchEvent, z: string, t: Dict): Msg {
  const w = t.watch;
  switch (e.type) {
    case 'grid_high':
      return {
        text: `<b>${w.gridHigh(kw1(e.load.totalW))}</b>\n<i>${w.gridHighNote(kw1(e.load.homeW), kw1(e.load.batteryW), e.limitW / 1000, BREAKER_W / 1000)}</i>`,
        silent: false,
      };
    case 'grid_ok':
      return { text: `<b>${w.gridOk(kw1(e.totalW))}</b>`, silent: true };
    case 'temp_high':
      return { text: `<b>${w.tempHigh(e.which, Math.round(e.tempC))}</b>\n<i>${w.tempHighNote(e.limitC)}</i>`, silent: false };
    case 'temp_ok':
      return { text: `<b>${w.tempOk(e.which, Math.round(e.tempC))}</b>`, silent: true };
    case 'alert_new': {
      const a = e.alert;
      const title = [a.code, a.name].filter(Boolean).map((x) => esc(String(x))).join(' · ');
      const quote = title ? [title] : [];
      if (a.startTs !== null) quote.push(`${w.since(fmtTime(a.startTs, z))}${a.level ? w.level(esc(a.level)) : ''}`);
      if (a.endTs !== null && a.startTs !== null) quote.push(w.alreadyEnded(fmtDuration(a.endTs - a.startTs, t)));
      const head = `<b>${w.inverterFault}</b>`;
      return { text: quote.length ? `${head}\n<blockquote>${quote.join('\n')}</blockquote>` : head, silent: false };
    }
    case 'alert_end': {
      const a = e.alert;
      const took = a.endTs !== null && a.startTs !== null ? `\n<i>${w.lasted(fmtDuration(a.endTs - a.startTs, t))}</i>` : '';
      return { text: `<b>${w.faultEnded(esc([a.code, a.name].filter(Boolean).join(' · ')))}</b>${took}`, silent: true };
    }
    case 'night_short':
      if (e.target === 'schedule')
        return {
          text: [
            `<b>${w.mayNotLast}</b>`,
            `<blockquote>${w.avgLoad(Math.round(e.soc), fmtPower(e.loadW, t))}`,
            w.lastsUntil(fmtTime(e.endsAt, z)),
            `${w.untilScheduled(fmtTime(e.morningTs, z), fmtPower(round10(e.needW), t))}</blockquote>`,
          ].join('\n'),
          silent: false,
        };
      return {
        text: [
          `<b>${w.nightShort}</b>`,
          `<blockquote>${w.avgLoad(Math.round(e.soc), fmtPower(e.loadW, t))}`,
          ...(round10(e.needW) > 0
            ? [w.lastsUntil(fmtTime(e.endsAt, z)), `${w.toReachMorning(fmtTime(e.morningTs, z), fmtPower(round10(e.needW), t))}</blockquote>`]
            : [`${w.atReserve}</blockquote>`]),
        ].join('\n'),
        silent: false,
      };
  }
}

export function renderCloud(e: CloudEvent, z: string, t: Dict): Msg {
  const o = t.ops;
  switch (e.type) {
    case 'cloud_auth':
      return { text: `<b>${o.cloudAuth}</b>\n<i>${esc(e.error)}</i>\n${o.cloudAuthHint}`, silent: false };
    case 'cloud_down':
      return { text: `<b>${o.cloudDown(fmtTime(e.sinceTs, z))}</b>\n<i>${esc(e.error)}</i>`, silent: true };
    case 'cloud_up':
      return { text: `<b>${o.cloudUp}</b>\n<i>${o.noLinkFor(fmtDuration(e.ts - e.sinceTs, t))}</i>`, silent: true };
  }
}

export function renderStartup(kind: 'first' | 'restart' | 'crash', downMs: number | null, z: string, nowMs: number, t: Dict): Msg {
  const o = t.ops;
  const why = kind === 'first' ? o.firstStart : kind === 'restart' ? o.afterRestart : o.afterCrash;
  const down = downMs !== null && downMs >= 60_000 ? o.wasDown(fmtDuration(downMs, t)) : '';
  return { text: `<b>${o.started(fmtTime(nowMs, z))}</b>\n<i>${why}${down}</i>`, silent: true };
}

export function renderError(key: string, t: Dict, repeats = 0): Msg {
  const head = repeats ? t.ops.repeated(repeats) : t.ops.botError;
  return { text: `<b>${head}</b>\n<code>${esc(key.slice(0, 600))}</code>`, silent: true };
}

export interface StatusInfo {
  nowMs: number;
  startedAt: number;
  lastOkAt: number | null;
  lastFrameTs: number | null;
  lagMs: number;
  periodMs: number;
  nextPollAt: number | null;
  errors24h: number;
  lastError: { at: number; msg: string } | null;
  cloudFailingSince: number | null;
  alertsActive: number | null; // null = not supported
  alertsCheckedAt: number | null;
  batteryTempC: number | null;
  inverterTempC: number | null;
  dbBytes: number;
  readings: number;
  outages: number;
  users: number;
  rssMb: number;
}

const hms = (ts: number, z: string) => DateTime.fromMillis(ts, { zone: z }).toFormat('HH:mm:ss');

export function renderStatus(s: StatusInfo, z: string, t: Dict): string {
  const st = t.status;
  const ago = (ms: number) => (ms < 60_000 ? st.secAgo(Math.max(0, Math.round(ms / 1000))) : st.ago(fmtDuration(ms, t)));
  const L = [st.title];
  L.push(st.uptime(fmtDuration(s.nowMs - s.startedAt, t), DateTime.fromMillis(s.startedAt, { zone: z }).toFormat('dd.MM HH:mm')));
  L.push(s.cloudFailingSince !== null ? st.cloudErrors(fmtTime(s.cloudFailingSince, z)) : st.cloudAnswered(s.lastOkAt !== null ? ago(s.nowMs - s.lastOkAt) : '—'));
  if (s.lastFrameTs !== null) L.push(st.lastFrame(hms(s.lastFrameTs, z), Math.round(s.lagMs / 1000)));
  L.push(`${st.pollEvery(Math.round(s.periodMs / 60_000))}${s.nextPollAt !== null ? st.nextPoll(hms(s.nextPollAt, z)) : ''}`);
  L.push(`${st.errors24h(s.errors24h)}${s.lastError ? st.lastError(fmtTime(s.lastError.at, z), esc(s.lastError.msg.slice(0, 160))) : ''}`);
  L.push(
    s.alertsActive === null
      ? st.faultsUnsupported
      : `${st.faults(s.alertsActive ? st.activeN(s.alertsActive) : st.none)}${s.alertsCheckedAt !== null ? st.checkedAt(fmtTime(s.alertsCheckedAt, z)) : ''}`,
  );
  const temp = (v: number | null) => (v === null ? '—' : `${Math.round(v)}°C`);
  L.push(st.temps(temp(s.batteryTempC), temp(s.inverterTempC)));
  L.push(st.db((s.dbBytes / 1e6).toFixed(1), s.readings, s.outages));
  L.push(st.users(s.users, Math.round(s.rssMb)));
  return L.join('\n');
}
