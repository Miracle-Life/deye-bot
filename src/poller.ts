import type { Config } from './config.js';
import type { DataSource, Reading } from './deye/types.js';
import { DateTime } from 'luxon';
import { dropFutureLastTs, fromFuture, initialState, missedWhileDown, stepTick, stepWithGap, type DetectorConfig, type DetectorEvent, type DetectorState } from './domain/detector.js';
import { DeyeAuthError } from './deye/official.js';
import type { PollOutcome } from './domain/ops.js';
import { DEFAULT_TIMING, nextPollDelay, updateTiming, type PollTiming } from './domain/schedule.js';
import { errInfo, log } from './log.js';
import type { Repo } from './storage/repo.js';

const DAY = 86_400_000;
const RETENTION_MS = 90 * DAY;
const MANUAL_MIN_GAP_MS = 20_000;

export type Notify = (e: DetectorEvent) => Promise<void>;

export class Poller {
  state: DetectorState;
  /** Called after a new live reading is stored and its events are sent. */
  onFresh: ((r: Reading) => Promise<void>) | null = null;
  /** Called after every poll attempt (health tracking). */
  onPoll: ((o: PollOutcome) => void) | null = null;
  nextPollAt: number | null = null;
  /** Error of the last poll, null after a success. */
  lastError: string | null = null;
  private timing: PollTiming = DEFAULT_TIMING;
  private timer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private lastPollAt = 0;
  private running: Promise<void> | null = null;

  constructor(
    private src: DataSource,
    private repo: Repo,
    private cfg: Config,
    private notify: Notify,
  ) {
    this.state = dropFutureLastTs(repo.getState() ?? initialState, Date.now());
  }

  // Read live: thresholds can change from the settings menu.
  private get dcfg(): DetectorConfig {
    const c = this.cfg;
    return { offV: c.gridOffVolts, okV: c.gridOkVolts, staleMs: c.staleAfterMin * 60_000, thresholds: c.batteryThresholds };
  }

  async start(): Promise<void> {
    this.purge();
    this.retentionTimer = setInterval(() => this.purge(), DAY);
    // Hold `running` during the replay: a tap on "Обновить" must not jump lastTs ahead of it.
    let missed: DetectorEvent[] = [];
    const replay = this.backfill()
      .then((m) => void (missed = m))
      .catch((e) => log.warn('backfill failed', errInfo(e)))
      .finally(() => (this.running = null));
    this.running = replay;
    await replay;
    await this.pollNow(true);
    // After the live poll so the notification picture shows a full reading.
    for (const e of missed) await this.notify(e).catch((err) => log.error('notify failed', { type: e.type, ...errInfo(err) }));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.timer = null;
    this.retentionTimer = null;
  }

  /** Manual refresh; rate-limited unless forced. */
  async pollNow(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastPollAt < MANUAL_MIN_GAP_MS) return;
    this.running = this.pollOnce().finally(() => {
      this.running = null;
      this.schedule();
    });
    return this.running;
  }

  /** Replays Deye history into the DB; returns grid changes that happened while the bot was down. */
  async backfill(): Promise<DetectorEvent[]> {
    const now = Date.now();
    const prevLastTs = this.state.lastTs;
    const from = Math.max(prevLastTs ?? 0, now - RETENTION_MS);
    const readings = (await this.src.history(from, now)).filter((r) => !fromFuture(r.ts, now)).sort((a, b) => a.ts - b.ts);
    let added = 0;
    const events: DetectorEvent[] = [];
    for (const r of readings) {
      if (!this.repo.insertReading(r)) continue;
      added++;
      events.push(...this.process(r, now, false));
    }
    this.repo.saveState(this.state);
    const missed = missedWhileDown(events, prevLastTs, now);
    log.info('backfill done', { fetched: readings.length, added, missed: missed.length });
    return missed;
  }

  /** Last poll attempt, ok or not (0 = none yet). */
  get lastAttemptAt(): number {
    return this.lastPollAt;
  }

  get framePeriodMs(): number {
    return this.timing.periodMs;
  }

  get lagMs(): number {
    return this.timing.lagMs;
  }

  /** When the next logger frame should become visible in the cloud. */
  nextFrameAt(): number | null {
    const t = this.state.lastTs;
    return t === null ? null : t + this.timing.periodMs + this.timing.lagMs;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = nextPollDelay(Date.now(), this.state.lastTs, this.timing, this.cfg.pollIntervalSec * 1000, this.failures);
    this.nextPollAt = Date.now() + delay;
    this.timer = setTimeout(() => void this.pollNow(true), delay);
  }

  private async pollOnce(): Promise<void> {
    this.lastPollAt = Date.now();
    const events: DetectorEvent[] = [];
    let fresh: Reading | null = null;
    let r: Reading | null = null;
    try {
      r = await this.src.latest();
      if (fromFuture(r.ts, Date.now())) throw new Error(`Deye reading is from the future: ${new Date(r.ts).toISOString()}`);
      this.failures = 0;
      this.lastError = null;
      this.onPoll?.({ ok: true });
    } catch (e) {
      r = null;
      this.failures++;
      log.warn('poll failed', { failures: this.failures, ...errInfo(e) });
      this.lastError = errInfo(e).error;
      this.onPoll?.({ ok: false, auth: e instanceof DeyeAuthError, error: this.lastError });
    }
    if (r) {
      const prevTs = this.state.lastTs;
      // A failing DB (disk full, read-only volume) must not stop outage alerts.
      const isNew = this.db(() => this.repo.upsertReading(r), prevTs === null || r.ts > prevTs);
      if (isNew) {
        fresh = r;
        if (prevTs !== null && r.ts > prevTs) this.timing = updateTiming(this.timing, prevTs, r.ts, Date.now());
        events.push(...this.process(r, Date.now(), true));
      }
    }
    const tick = stepTick(this.state, Date.now(), this.dcfg);
    this.state = tick.state;
    events.push(...tick.events);
    this.db(() => this.repo.saveState(this.state), undefined);
    for (const e of events) {
      try {
        await this.notify(e);
      } catch (err) {
        log.error('notify failed', { type: e.type, ...errInfo(err) });
      }
    }
    if (fresh) void this.onFresh?.(fresh).catch((err) => log.error('onFresh failed', errInfo(err)));
  }

  /** Runs one reading through the detector and persists its DB effects; returns events to notify. */
  private process(r: Reading, nowMs: number, live: boolean): DetectorEvent[] {
    const wasStale = this.state.stale;
    // A tick at the reading's own time marks long silences as gaps (replay, or a bot downtime the backfill missed).
    const res = stepWithGap(this.state, r, this.dcfg);
    this.state = res.state;
    for (const e of res.events) this.db(() => this.apply(e), undefined);
    const o = this.state.outage;
    if (o) this.db(() => !this.repo.hasOpenOutage() && this.repo.openOutage(o.startTs, o.startApprox, r.soc, o.missingPhases), undefined); // adopted silently
    if (live && nowMs - r.ts > this.dcfg.staleMs) log.warn('latest reading is old', { ageMin: Math.round((nowMs - r.ts) / 60_000) });
    // Live: a gap found only now was the bot's own downtime, not Deye's silence — record it, don't announce it.
    return live && !wasStale ? res.events.filter((e) => e.type !== 'data_stale' && e.type !== 'data_resumed') : res.events;
  }

  /** Runs a DB write; on failure logs it and returns `fallback` so polling and alerts go on. */
  private db<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      log.error('db write failed', errInfo(e));
      return fallback;
    }
  }

  private apply(e: DetectorEvent): void {
    switch (e.type) {
      case 'outage_started':
        this.repo.openOutage(e.ts, e.approxFromTs !== null, e.reading.soc, e.missingPhases);
        break;
      case 'outage_ended':
        this.repo.closeOutage(e.ts, e.reading.soc);
        break;
      case 'data_resumed':
        this.repo.insertGap(e.gapFromTs, e.ts);
        break;
    }
  }

  private purge(): void {
    try {
      const cutoff = Date.now() - RETENTION_MS;
      const energyDays = this.repo.purgeEnergyBefore(DateTime.fromMillis(cutoff, { zone: this.cfg.timezone }).toISODate()!);
      log.info('retention purge', { ...this.repo.purgeOlderThan(cutoff), energyDays });
    } catch (e) {
      log.error('retention purge failed', errInfo(e));
    }
  }
}
