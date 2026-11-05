// Checks in with the Cloudflare watchdog so it can tell users when the home goes offline.
import type { Config } from './config.js';
import { errInfo, log } from './log.js';
import type { Repo, UserRow } from './storage/repo.js';
import type { Lang } from './i18n/index.js';

/** Same shape as Beat in worker/src/logic.ts (separate build, kept in sync by tests). */
export interface Beat {
  ts: number;
  tz: string;
  quietFrom: number;
  quietTo: number;
  chats: { id: number; muted: boolean; nightQuiet: boolean; lang: Lang }[];
}

const EVERY_MS = 3 * 60_000;
const TIMEOUT_MS = 15_000;

const STALLED_MS = 15 * 60_000; // poll backoff tops out at 10 min

/** The bot counts as alive only while it keeps polling Deye (a wedged poller must look like "home offline"). */
export function pollerAlive(lastAttemptAt: number, startedAt: number, nowMs: number): boolean {
  return nowMs - Math.max(lastAttemptAt, startedAt) <= STALLED_MS;
}

export function heartbeatPayload(users: UserRow[], cfg: Pick<Config, 'timezone' | 'quietFrom' | 'quietTo'>, nowMs: number): Beat {
  return {
    ts: nowMs,
    tz: cfg.timezone,
    quietFrom: cfg.quietFrom,
    quietTo: cfg.quietTo,
    chats: users.filter((u) => u.status === 'approved' && u.watchdog).map((u) => ({ id: u.tgId, muted: u.muted, nightQuiet: u.nightQuiet, lang: u.lang })),
  };
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private failing = false;

  private readonly startedAt = Date.now();

  constructor(
    private cfg: Config,
    private repo: Repo,
    private lastPollAttemptAt: () => number,
  ) {}

  get enabled(): boolean {
    return !!(this.cfg.watchdogUrl && this.cfg.watchdogSecret);
  }

  start(): void {
    if (!this.enabled) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async beat(): Promise<void> {
    if (!pollerAlive(this.lastPollAttemptAt(), this.startedAt, Date.now())) {
      log.warn('poller stalled, skipping watchdog beat');
      return;
    }
    try {
      const res = await fetch(new URL('/beat', this.cfg.watchdogUrl!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.watchdogSecret}` },
        body: JSON.stringify(heartbeatPayload(this.repo.listUsers(), this.cfg, Date.now())),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`watchdog HTTP ${res.status}`);
      if (this.failing) log.info('watchdog reachable again');
      this.failing = false;
    } catch (e) {
      // warn, not error: no internet is exactly what the watchdog reports itself.
      if (!this.failing) log.warn('watchdog beat failed', errInfo(e));
      this.failing = true;
    }
  }
}
