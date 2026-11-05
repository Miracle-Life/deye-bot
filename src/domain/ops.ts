// Pure helpers for the bot's own health: cloud reachability, error de-duplication, quiet hours.
import { DateTime } from 'luxon';

export interface CloudState {
  failingSince: number | null;
  downNotified: boolean;
  authNotified: boolean;
}

export const initialCloud: CloudState = { failingSince: null, downNotified: false, authNotified: false };

export type PollOutcome = { ok: true } | { ok: false; auth: boolean; error: string };

export type CloudEvent =
  | { type: 'cloud_down'; sinceTs: number; error: string }
  | { type: 'cloud_up'; sinceTs: number; ts: number }
  | { type: 'cloud_auth'; error: string };

export function stepCloud(s: CloudState, o: PollOutcome, nowMs: number, downAfterMs: number): { state: CloudState; event: CloudEvent | null } {
  if (o.ok) {
    const event = s.downNotified || s.authNotified ? { type: 'cloud_up' as const, sinceTs: s.failingSince ?? nowMs, ts: nowMs } : null;
    return { state: initialCloud, event };
  }
  const state = { ...s, failingSince: s.failingSince ?? nowMs };
  if (o.auth && !s.authNotified) return { state: { ...state, authNotified: true }, event: { type: 'cloud_auth', error: o.error } };
  if (!state.downNotified && !state.authNotified && nowMs - state.failingSince >= downAfterMs) {
    return { state: { ...state, downNotified: true }, event: { type: 'cloud_down', sinceTs: state.failingSince, error: o.error } };
  }
  return { state, event: null };
}

/** First occurrence of an error goes out at once; repeats within the window are counted and summarized. */
export class ErrorDigest {
  private seen = new Map<string, { since: number; repeats: number }>();

  constructor(private windowMs: number) {}

  add(key: string, nowMs: number): boolean {
    const e = this.seen.get(key);
    if (e && nowMs - e.since < this.windowMs) {
      e.repeats++;
      return false;
    }
    this.seen.set(key, { since: nowMs, repeats: 0 });
    return true;
  }

  /** Expired windows with repeats, then forgotten. */
  flush(nowMs: number): { key: string; count: number }[] {
    const out: { key: string; count: number }[] = [];
    for (const [key, e] of this.seen) {
      if (nowMs - e.since < this.windowMs) continue;
      if (e.repeats) out.push({ key, count: e.repeats });
      this.seen.delete(key);
    }
    return out;
  }
}

export function isQuietHour(nowMs: number, zone: string, from = 23, to = 7): boolean {
  const h = DateTime.fromMillis(nowMs, { zone }).hour;
  return from > to ? h >= from || h < to : h >= from && h < to;
}
