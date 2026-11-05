import type { Reading } from '../deye/types.js';
import { classifyGrid, type GridState, type Phase } from './grid.js';

export interface DetectorConfig {
  offV: number;
  okV: number;
  staleMs: number;
  thresholds: number[];
}

export interface DetectorState {
  grid: GridState | null;
  pending: { state: GridState; ts: number; approxFromTs: number | null } | null; // awaiting 2nd sample
  lastTs: number | null;
  stale: boolean;
  staleSinceTs: number | null;
  outage: {
    startTs: number;
    startApprox: boolean;
    approxFromTs: number | null;
    thresholdsSent: number[];
    missingPhases: Phase[];
    lastSoc?: number; // previous charge during this outage (absent in older saved states)
  } | null;
  charge: { startTs: number | null; fullSent: boolean };
}

export type DetectorEvent =
  | { type: 'outage_started'; ts: number; approxFromTs: number | null; missingPhases: Phase[]; reading: Reading }
  | { type: 'outage_ended'; ts: number; approxFromTs: number | null; startTs: number; reading: Reading }
  | { type: 'battery_low'; ts: number; threshold: number; outageStartTs: number; reading: Reading }
  | { type: 'battery_full'; ts: number; chargeStartTs: number | null }
  | { type: 'data_stale'; sinceTs: number }
  | { type: 'data_resumed'; ts: number; gapFromTs: number };

export const initialState: DetectorState = {
  grid: null,
  pending: null,
  lastTs: null,
  stale: false,
  staleSinceTs: null,
  outage: null,
  charge: { startTs: null, fullSent: false },
};

type Step = { state: DetectorState; events: DetectorEvent[] };

function crossed(thresholds: number[], soc: number | null, sent: number[]): number[] {
  if (soc === null) return [];
  return thresholds.filter((t) => soc <= t && !sent.includes(t));
}

export function stepReading(prev: DetectorState, r: Reading, cfg: DetectorConfig): Step {
  if (prev.lastTs !== null && r.ts <= prev.lastTs) return { state: prev, events: [] };

  const s: DetectorState = structuredClone(prev);
  const events: DetectorEvent[] = [];
  const prevTs = s.lastTs;
  const gapped = prevTs !== null && r.ts - prevTs > cfg.staleMs;
  s.lastTs = r.ts;

  if (s.stale) {
    events.push({ type: 'data_resumed', ts: r.ts, gapFromTs: s.staleSinceTs ?? prevTs ?? r.ts });
    s.stale = false;
    s.staleSinceTs = null;
  }

  const sample = classifyGrid(r, cfg.offV, cfg.okV);

  if (sample.state !== null) {
    if (s.grid === null) {
      // First reading ever: adopt state silently.
      s.grid = sample.state;
      s.charge.fullSent = (r.soc ?? 0) >= 100;
      if (sample.state === 'off') {
        s.outage = {
          startTs: r.ts,
          startApprox: true,
          approxFromTs: null,
          thresholdsSent: crossed(cfg.thresholds, r.soc, []),
          missingPhases: sample.missingPhases,
        };
      }
      return { state: s, events };
    }

    if (sample.state !== s.grid) {
      const confirms = s.pending?.state === sample.state;
      if (sample.ambiguous && !confirms) {
        s.pending = { state: sample.state, ts: r.ts, approxFromTs: gapped ? prevTs : null };
      } else {
        const ts = confirms ? s.pending!.ts : r.ts;
        const approxFromTs = confirms ? s.pending!.approxFromTs : gapped ? prevTs : null;
        s.pending = null;
        if (sample.state === 'off') {
          s.grid = 'off';
          s.outage = {
            startTs: ts,
            startApprox: false,
            approxFromTs,
            // Thresholds already below at outage start are covered by the outage message.
            thresholdsSent: crossed(cfg.thresholds, r.soc, []),
            missingPhases: sample.missingPhases,
          };
          events.push({ type: 'outage_started', ts, approxFromTs, missingPhases: sample.missingPhases, reading: r });
        } else {
          events.push({ type: 'outage_ended', ts, approxFromTs, startTs: s.outage?.startTs ?? ts, reading: r });
          s.grid = 'on';
          s.outage = null;
          // Back already full (short outage, sun): nothing to announce later.
          s.charge = { startTs: ts, fullSent: (r.soc ?? 0) >= 100 };
        }
        return finishBattery(s, r, cfg, events, true);
      }
    } else {
      s.pending = null;
      if (s.outage && sample.state === 'off' && !sample.ambiguous) s.outage.missingPhases = sample.missingPhases;
    }
  }

  return finishBattery(s, r, cfg, events, false);
}

function finishBattery(s: DetectorState, r: Reading, cfg: DetectorConfig, events: DetectorEvent[], justChanged: boolean): Step {
  const soc = r.soc;
  if (soc === null) return { state: s, events };

  if (s.grid === 'off' && s.outage && !justChanged) {
    // Only thresholds actually crossed since the last reading: one added in settings
    // above the current charge must not fire.
    const prevSoc = s.outage.lastSoc ?? soc;
    const hit = crossed(cfg.thresholds, soc, s.outage.thresholdsSent).filter((t) => prevSoc > t);
    if (hit.length) {
      s.outage.thresholdsSent.push(...hit);
      events.push({ type: 'battery_low', ts: r.ts, threshold: Math.min(...hit), outageStartTs: s.outage.startTs, reading: r });
    }
  }

  if (s.grid === 'off' && s.outage) s.outage.lastSoc = soc;

  if (s.grid === 'on') {
    if (soc < 98 && (r.batteryPowerW ?? 0) > 0 && s.charge.fullSent) {
      s.charge = { startTs: r.ts, fullSent: false };
    }
    if (soc >= 100 && !s.charge.fullSent) {
      s.charge.fullSent = true;
      events.push({ type: 'battery_full', ts: r.ts, chargeStartTs: s.charge.startTs });
    }
  }
  return { state: s, events };
}

export function stepTick(prev: DetectorState, nowMs: number, cfg: DetectorConfig): Step {
  if (prev.stale || prev.lastTs === null || nowMs - prev.lastTs <= cfg.staleMs) return { state: prev, events: [] };
  return {
    state: { ...prev, stale: true, staleSinceTs: prev.lastTs },
    events: [{ type: 'data_stale', sinceTs: prev.lastTs }],
  };
}

const MISSED_MAX_AGE_MS = 6 * 3_600_000;

/**
 * Grid changes found while replaying history after a restart. Replay is silent by design,
 * but a change during the bot's own downtime still has to reach people (late beats never).
 * First start (no previous data) and anything older than 6 h stay silent.
 */
export function missedWhileDown(events: DetectorEvent[], prevLastTs: number | null, nowMs: number): DetectorEvent[] {
  if (prevLastTs === null) return [];
  return events.filter(
    (e) => (e.type === 'outage_started' || e.type === 'outage_ended') && e.ts > prevLastTs && nowMs - e.ts <= MISSED_MAX_AGE_MS,
  );
}

// A wrong logger clock (or ms instead of s) must not pin the detector to a future time.
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

export const fromFuture = (ts: number, nowMs: number) => ts > nowMs + MAX_CLOCK_SKEW_MS;

export function dropFutureLastTs(s: DetectorState, nowMs: number): DetectorState {
  return s.lastTs !== null && fromFuture(s.lastTs, nowMs) ? { ...s, lastTs: null } : s;
}

/** A tick at the reading's own time first, so a silence (bot down, backfill failed) is recorded as a gap. */
export function stepWithGap(prev: DetectorState, r: Reading, cfg: DetectorConfig): Step {
  const pre = stepTick(prev, r.ts, cfg);
  const res = stepReading(pre.state, r, cfg);
  return { state: res.state, events: [...pre.events, ...res.events] };
}
