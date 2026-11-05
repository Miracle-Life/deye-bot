// Poll timing: the logger uploads a frame every few minutes, so polling right after
// the next frame should land beats polling on a fixed interval.

export interface PollTiming {
  periodMs: number; // logger upload period
  lagMs: number; // frame timestamp → visible via the cloud API
}

const S = 1000;
export const DEFAULT_TIMING: PollTiming = { periodMs: 180 * S, lagMs: 40 * S };
const FAST_MS = 10 * S;
const SLACK_MS = 2 * S;
const GRACE_MS = 120 * S; // how long to retry fast for a late frame
const MAX_WAIT_MS = 5 * 60 * S;
const MAX_BACKOFF_MS = 10 * 60 * S;

export function nextPollDelay(nowMs: number, lastTs: number | null, t: PollTiming, baseMs: number, failures: number): number {
  if (failures > 0) return Math.min(baseMs * 2 ** Math.min(failures, 10), Math.max(baseMs, MAX_BACKOFF_MS));
  if (lastTs === null) return baseMs;
  const wait = lastTs + t.periodMs + t.lagMs - nowMs;
  if (wait > 0) return Math.min(wait + SLACK_MS, MAX_WAIT_MS);
  return -wait <= GRACE_MS ? FAST_MS : baseMs;
}

export function updateTiming(t: PollTiming, prevTs: number, newTs: number, seenAtMs: number): PollTiming {
  const p = newTs - prevTs;
  const periodMs = p >= 30 * S && p <= 15 * 60 * S ? p : t.periodMs;
  const seen = Math.max(0, seenAtMs - newTs);
  // Our own polling inflates the observed lag, so trust fast samples and drift up slowly.
  const lagMs = seen <= t.lagMs ? seen : Math.round(t.lagMs + (seen - t.lagMs) * 0.2);
  return { periodMs, lagMs };
}
