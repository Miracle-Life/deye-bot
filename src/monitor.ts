// Runtime side of the health and problem checks: keeps state, runs timers, sends messages.
import { statSync } from 'node:fs';
import { renderCloud, renderError, renderStartup, renderStatus, renderWatch } from './bot/ops-format.js';
import type { Msg } from './bot/format.js';
import type { Dict } from './i18n/index.js';
import type { Config } from './config.js';
import type { DataSource, Reading } from './deye/types.js';
import { ErrorDigest, initialCloud, stepCloud, type CloudState, type PollOutcome } from './domain/ops.js';
import { gridLoad, gridWatchStep } from './domain/load.js';
import { batteryVerdict } from './schedule/logic.js';
import { diffAlerts, initialWatch, nightShortfall, shouldWarnShort, stepTemps, type WatchEvent, type WatchState } from './domain/watch.js';
import { errInfo, log } from './log.js';
import type { Poller } from './poller.js';
import type { Repo } from './storage/repo.js';

export type Audience = 'all' | 'admin';
/** Built per language: each recipient gets the version in their own language. */
export type Render = (t: Dict) => Msg;
export type Send = (render: Render, audience: Audience) => Promise<void>;

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const ALERTS_EVERY_MS = 5 * MIN;
const ALERTS_WINDOW_MS = 2 * DAY;
const AVG_LOAD_MS = 15 * MIN;

interface Lifecycle {
  aliveAt: number;
  clean: boolean;
}

export class Monitor {
  readonly startedAt = Date.now();
  private lastOkAt: number | null = null;
  private errors: { at: number; msg: string }[] = [];
  private cloud: CloudState = initialCloud;
  private watch: WatchState;
  private alertsCheckedAt: number | null = null;
  private digest = new ErrorDigest(H);
  private timers: NodeJS.Timeout[] = [];
  /** Scheduled power-on for the current outage (from the YASNO schedule), if known. */
  scheduleTarget: (() => number | null) | null = null;

  constructor(
    private src: DataSource,
    private repo: Repo,
    private poller: Poller,
    private cfg: Config,
    private send: Send,
  ) {
    this.watch = { ...initialWatch, ...(repo.getKv<WatchState>('watch') ?? {}) };
  }

  start(): void {
    const prev = this.repo.getKv<Lifecycle>('lifecycle');
    const now = Date.now();
    const kind = !prev ? 'first' : prev.clean ? 'restart' : 'crash';
    this.saveLifecycle({ aliveAt: now, clean: false });
    void this.sendSafe((t) => renderStartup(kind, prev ? now - prev.aliveAt : null, this.cfg.timezone, now, t), 'admin');

    this.every(MIN, () => this.saveLifecycle({ aliveAt: Date.now(), clean: false }));
    this.every(5 * MIN, () => this.flushDigest());
    if (this.src.alerts) {
      this.timers.push(setTimeout(() => void this.checkAlerts(), 20_000));
      this.every(ALERTS_EVERY_MS, () => void this.checkAlerts());
    }
  }

  /** Marks a clean shutdown so the next start says "after restart", not "after crash". */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.saveLifecycle({ aliveAt: Date.now(), clean: true });
  }

  // A throw here would escape a timer and kill the process (e.g. disk full).
  private saveLifecycle(l: Lifecycle): void {
    try {
      this.repo.setKv('lifecycle', l);
    } catch (e) {
      log.warn('lifecycle save failed', errInfo(e));
    }
  }

  onPoll(o: PollOutcome): void {
    const now = Date.now();
    if (o.ok) this.lastOkAt = now;
    else this.noteError(o.error, now);
    const { state, event } = stepCloud(this.cloud, o, now, this.cfg.cloudDownAfterMin * MIN);
    this.cloud = state;
    if (event) void this.sendSafe((t) => renderCloud(event, this.cfg.timezone, t), 'admin');
  }

  /** New live reading: temperatures and the "won't last until morning" check. */
  async onReading(r: Reading): Promise<void> {
    const events: [WatchEvent, Audience][] = [];
    const t = stepTemps(this.watch.temps, r, { batteryMaxC: this.cfg.batteryTempMaxC, inverterMaxC: this.cfg.inverterTempMaxC });
    this.watch = { ...this.watch, temps: t.state };
    events.push(...t.events.map((e): [WatchEvent, Audience] => [e, 'admin']));

    const limitW = this.cfg.gridLoadMaxKw * 1000;
    const g = gridWatchStep(this.watch.gridHigh, this.poller.state.grid, r.gridPowerW, limitW);
    this.watch = { ...this.watch, gridHigh: g.high };
    const load = gridLoad(r);
    if (g.event === 'high' && load) events.push([{ type: 'grid_high', load, limitW }, 'admin']);
    if (g.event === 'ok') events.push([{ type: 'grid_ok', totalW: Math.max(r.gridPowerW ?? 0, 0) }, 'admin']);

    if (this.poller.state.grid === 'off' && r.soc !== null) {
      // Battery discharge, not house load: daytime solar covers part of the load.
      const discharge = this.repo
        .readingsBetween(r.ts - AVG_LOAD_MS, r.ts + 1)
        .map((x) => x.batteryPowerW)
        .filter((w): w is number => w !== null && w < 0)
        .map((w) => -w);
      const avg = discharge.length ? discharge.reduce((a, b) => a + b, 0) / discharge.length : null;
      const cap = r.batteryCapacityKwh ?? this.cfg.batteryCapacityKwh;
      const pv = Math.max(0, r.pvPowerW ?? 0);
      const target = this.scheduleTarget?.() ?? null;
      let warn: { key: string; e: WatchEvent } | null = null;
      if (avg !== null && target !== null) {
        const v = batteryVerdict(r.soc, avg, pv, r.ts, target, { capacityKwh: cap, reservePct: this.cfg.batteryReservePct });
        if (!v.ok) warn = { key: `sched@${target}`, e: { type: 'night_short', target: 'schedule', soc: r.soc, loadW: avg, endsAt: v.endsAt, needW: v.adviseLoadW, morningTs: target } };
      } else if (avg !== null) {
        const w = nightShortfall(r.soc, avg, r.ts, { capacityKwh: cap, reservePct: this.cfg.batteryReservePct, timezone: this.cfg.timezone });
        if (w) warn = { key: w.morningKey, e: { type: 'night_short', target: 'morning', soc: r.soc, loadW: avg, endsAt: w.endsAt, needW: w.needW + pv, morningTs: w.morningTs } };
      }
      if (warn && shouldWarnShort(this.watch.nightWarnFor, warn.key)) {
        this.watch = { ...this.watch, nightWarnFor: warn.key };
        events.push([warn.e, 'all']);
      }
    }
    this.repo.setKv('watch', this.watch);
    for (const [e, who] of events) await this.sendSafe((t) => renderWatch(e, this.cfg.timezone, t), who);
  }

  /** Sink for log.error: first occurrence goes to the admin, repeats are summarized hourly. */
  reportError(msg: string, extra?: object): void {
    const detail = (extra as { error?: string } | undefined)?.error;
    const key = detail ? `${msg}: ${detail}` : msg;
    const now = Date.now();
    this.noteError(key, now);
    if (this.digest.add(key, now)) void this.sendSafe((t) => renderError(key, t), 'admin');
  }

  status(t: Dict): string {
    const now = Date.now();
    const latest = this.repo.latestReading();
    const size = (p: string) => {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    };
    const counts = this.repo.counts();
    const active = Object.values(this.watch.alerts).filter((a) => a.active).length;
    this.pruneErrors(now);
    return renderStatus(
      {
        nowMs: now,
        startedAt: this.startedAt,
        lastOkAt: this.lastOkAt,
        lastFrameTs: latest?.ts ?? null,
        lagMs: this.poller.lagMs,
        periodMs: this.poller.framePeriodMs,
        nextPollAt: this.poller.nextPollAt,
        errors24h: this.errors.length,
        lastError: this.errors.at(-1) ?? null,
        cloudFailingSince: this.cloud.failingSince,
        alertsActive: this.src.alerts ? active : null,
        alertsCheckedAt: this.alertsCheckedAt,
        batteryTempC: latest?.batteryTempC ?? null,
        inverterTempC: latest?.inverterTempC ?? null,
        dbBytes: size(this.cfg.dbPath) + size(`${this.cfg.dbPath}-wal`),
        readings: counts.readings,
        outages: counts.outages,
        users: this.repo.approvedUsers().length,
        rssMb: process.memoryUsage().rss / 1e6,
      },
      this.cfg.timezone,
      t,
    );
  }

  private async checkAlerts(): Promise<void> {
    try {
      const now = Date.now();
      const list = await this.src.alerts!(now - ALERTS_WINDOW_MS, now);
      const r = diffAlerts(this.watch.alerts, list, !this.watch.alertsInit, now);
      this.watch = { ...this.watch, alerts: r.known, alertsInit: true };
      this.alertsCheckedAt = now;
      this.repo.setKv('watch', this.watch);
      for (const e of r.events) await this.sendSafe((t) => renderWatch(e, this.cfg.timezone, t), 'admin');
    } catch (e) {
      log.warn('alert check failed', errInfo(e));
    }
  }

  private flushDigest(): void {
    for (const { key, count } of this.digest.flush(Date.now())) void this.sendSafe((t) => renderError(key, t, count), 'admin');
  }

  private noteError(msg: string, now: number): void {
    this.errors.push({ at: now, msg });
    this.pruneErrors(now);
  }

  private pruneErrors(now: number): void {
    while (this.errors.length && now - this.errors[0]!.at > DAY) this.errors.shift();
  }

  private every(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms));
  }

  // Never log.error here: that would feed reportError and could loop.
  private async sendSafe(render: Render, who: Audience): Promise<void> {
    try {
      await this.send(render, who);
    } catch (e) {
      log.warn('monitor send failed', errInfo(e));
    }
  }
}
