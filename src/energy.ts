// Fetches and caches per-day energy counters from Deye for the spending card.
import { DateTime } from 'luxon';
import type { Config } from './config.js';
import type { DataSource } from './deye/types.js';
import { summarizeFrames, type EnergyDayRaw } from './domain/energy.js';
import { errInfo, log } from './log.js';
import type { Repo } from './storage/repo.js';

const TODAY_TTL_MS = 3 * 60_000;
const FETCH_GAP_MS = 400;
const KEEP_DAYS = 90;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TodayCache = { at: number; day: EnergyDayRaw } | null;

/** The in-memory "today" may be used only for its own date (not past midnight) and while fresh. */
export const freshToday = (c: TodayCache, iso: string, nowMs: number) => c !== null && c.day.date === iso && nowMs - c.at < TODAY_TTL_MS;

export class EnergyService {
  private today: TodayCache = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private src: DataSource,
    private repo: Repo,
    private cfg: Config,
  ) {}

  get supported(): boolean {
    return !!this.src.energyFrames;
  }

  /** True when the month can be shown without calling Deye (all past days cached). */
  cached(monthIso: string): boolean {
    const days = this.daysOf(monthIso);
    const have = new Set(this.repo.energyDays(days[0] ?? '', days.at(-1) ?? '').filter((d) => d.complete).map((d) => d.day.date));
    const today = this.todayIso();
    return days.every((d) => have.has(d) || (d === today && freshToday(this.today, d, Date.now())));
  }

  /** Days of the month up to today that have data; fills the cache as needed (one request per day). */
  async month(monthIso: string): Promise<EnergyDayRaw[]> {
    // Fully cached: no Deye calls, so don't wait behind a long load (grammY handles updates one by one).
    if (this.cached(monthIso)) return this.load(monthIso);
    // Serialize: two taps must not double the Deye requests.
    const run = this.busy.then(() => this.load(monthIso));
    this.busy = run.catch(() => {});
    return run;
  }

  /** Background warm-up of the current month and cleanup of old days. */
  async warm(): Promise<void> {
    try {
      this.repo.purgeEnergyBefore(DateTime.now().setZone(this.cfg.timezone).minus({ days: KEEP_DAYS }).toISODate()!);
      await this.month(this.todayIso().slice(0, 7));
    } catch (e) {
      log.warn('energy warm-up failed', errInfo(e));
    }
  }

  private async load(monthIso: string): Promise<EnergyDayRaw[]> {
    const days = this.daysOf(monthIso);
    if (!days.length) return [];
    const stored = new Map(this.repo.energyDays(days[0]!, days.at(-1)!).map((d) => [d.day.date, d]));
    const today = this.todayIso();
    const out: EnergyDayRaw[] = [];
    for (const iso of days) {
      const s = stored.get(iso);
      if (s?.complete) {
        out.push(s.day);
        continue;
      }
      if (iso === today && freshToday(this.today, iso, Date.now())) {
        out.push(this.today!.day);
        continue;
      }
      const day = summarizeFrames(await this.src.energyFrames!(iso), iso, this.cfg.timezone);
      if (iso === today) this.today = { at: Date.now(), day };
      this.repo.putEnergyDay(day, iso !== today);
      out.push(day);
      await sleep(FETCH_GAP_MS);
    }
    return out;
  }

  private todayIso(): string {
    return DateTime.now().setZone(this.cfg.timezone).toISODate()!;
  }

  /** Month days from the first day we have any data for, up to today. */
  private daysOf(monthIso: string): string[] {
    const z = this.cfg.timezone;
    const start = DateTime.fromISO(`${monthIso}-01`, { zone: z });
    const earliest = this.repo.earliestDataTs();
    const from = earliest === null ? start : DateTime.max(start, DateTime.fromMillis(earliest, { zone: z }).startOf('day'));
    const today = DateTime.now().setZone(z).startOf('day');
    const out: string[] = [];
    for (let d = from; d < start.plus({ months: 1 }) && d <= today; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
    return out;
  }
}
