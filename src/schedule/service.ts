// Runtime side of the outage schedule: polling YASNO, persistence, admin notices, reminders.
import type { Msg } from '../bot/format.js';
import { esc, fmtTime } from '../bot/format.js';
import { dicts, type Dict } from '../i18n/index.js';
import { errInfo, log } from '../log.js';
import type { Repo, UserRow } from '../storage/repo.js';
import { dueReminders, refreshAllowed } from './logic.js';
import type { Address, Schedule } from './model.js';
import { YasnoFormatError, type YasnoClient } from './yasno.js';

const MIN = 60_000;
const POLL_MS = 20 * MIN;
const DAY = 24 * 60 * MIN;
const SENT_KEEP_MS = 2 * DAY;

const K = { address: 'schedule:address', last: 'schedule:last', sent: 'schedule:sent', notices: 'schedule:notices' } as const;

interface StoredAddress extends Address {
  resolvedAt: number; // last address → group check
}

interface Notices {
  format?: string; // last format error the admin was told about
  unknownTypes?: string[];
}

export type RefreshResult = 'ok' | 'limited' | 'failed' | 'no-address';

export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private lastManual: number | null = null;
  private running: Promise<RefreshResult> | null = null;
  private ticking = false;

  constructor(
    private repo: Repo,
    private client: YasnoClient,
    private tz: string,
    private notifyAdmin: (render: (t: Dict) => Msg) => void,
  ) {}

  start(): void {
    void this.refresh(false);
    this.timer = setInterval(() => void this.refresh(false), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  address(): Address | null {
    return this.stored();
  }

  /** null until the owner picks an address in ⚙️ Bot settings → 🏠 Address. */
  private stored(): StoredAddress | null {
    return this.repo.getKv<StoredAddress>(K.address);
  }

  /** Last good schedule for the current address (null until the first fetch). */
  get(): Schedule | null {
    const a = this.address();
    const s = this.repo.getKv<Schedule>(K.last);
    return a && s && s.group === a.group ? s : null;
  }

  // Address search for the owner's settings (kept here so the bot never talks to YASNO directly).
  searchStreets(query: string) {
    return this.client.streets(query);
  }

  searchHouses(streetId: number, query: string) {
    return this.client.houses(streetId, query);
  }

  groupOf(streetId: number, houseId: number) {
    return this.client.group(streetId, houseId);
  }

  /** Saves and fetches in the background (a poll for the old address may be running: fetch after it). */
  setAddress(a: Address): void {
    this.repo.setKv(K.address, { ...a, resolvedAt: Date.now() } satisfies StoredAddress);
    void (this.running ?? Promise.resolve()).then(() => this.refresh(false, true));
  }

  /** Fetches now; manual taps are rate-limited for everyone together. */
  async refresh(manual: boolean, force = false): Promise<RefreshResult> {
    if (!this.address()) return 'no-address';
    if (manual && !force) {
      if (!refreshAllowed(this.lastManual, Date.now())) return 'limited';
      this.lastManual = Date.now();
    }
    // One fetch at a time: a tap during a poll just waits for it.
    this.running ??= this.fetch().finally(() => (this.running = null));
    return this.running;
  }

  private async fetch(): Promise<RefreshResult> {
    try {
      let a = this.stored();
      if (!a) return 'no-address';
      try {
        a = await this.recheckGroup(a, false);
      } catch (e) {
        // The daily group check must not block the schedule itself; retried next poll.
        log.warn('schedule group recheck failed', errInfo(e));
      }
      let s: Schedule;
      try {
        s = await this.client.planned(a.group);
      } catch (e) {
        // The group key vanished: YASNO may have moved the address to another group.
        if (!(e instanceof YasnoFormatError) || !e.message.includes('no group')) throw e;
        a = await this.recheckGroup(a, true);
        s = await this.client.planned(a.group);
      }
      this.repo.setKv(K.last, s);
      if (this.notices().format) this.repo.setKv(K.notices, { ...this.notices(), format: undefined }); // recovered
      this.noticeUnknownTypes(s.unknownTypes);
      return 'ok';
    } catch (e) {
      if (e instanceof YasnoFormatError) this.noticeFormat(e.message);
      else log.warn('schedule fetch failed', errInfo(e));
      return 'failed';
    }
  }

  /** Re-resolves address → group once a day (or now when forced); switches and tells the admin on change. */
  private async recheckGroup(a: StoredAddress, force: boolean): Promise<StoredAddress> {
    if (!force && Date.now() - a.resolvedAt < DAY) return a;
    const group = await this.client.group(a.streetId, a.houseId);
    const next = { ...a, group, resolvedAt: Date.now() };
    const now = this.stored();
    // The owner may have picked another address meanwhile: don't write the old one back.
    if (!now || now.streetId !== a.streetId || now.houseId !== a.houseId) return now ?? a;
    this.repo.setKv(K.address, next);
    if (group !== a.group) {
      log.warn('schedule group changed', { from: a.group, to: group });
      this.notifyAdmin((t) => ({ text: t.schedule.groupChanged(a.group, group), silent: false }));
    }
    return next;
  }

  private notices(): Notices {
    return this.repo.getKv<Notices>(K.notices) ?? {};
  }

  private noticeFormat(msg: string): void {
    log.warn('schedule format error', { error: msg });
    if (this.notices().format === msg) return;
    this.repo.setKv(K.notices, { ...this.notices(), format: msg });
    this.notifyAdmin((t) => ({ text: t.schedule.formatChanged(esc(msg)), silent: true }));
  }

  private noticeUnknownTypes(types: string[]): void {
    const known = new Set(this.notices().unknownTypes ?? []);
    const fresh = types.filter((x) => !known.has(x));
    if (!fresh.length) return;
    this.repo.setKv(K.notices, { ...this.notices(), unknownTypes: [...known, ...fresh] });
    this.notifyAdmin((t) => ({ text: t.schedule.unknownType(esc(fresh.join(', '))), silent: true }));
  }

  /** Called every minute: per-user reminders before scheduled off/on. */
  async tickReminders(users: UserRow[], grid: 'on' | 'off' | null, sendTo: (u: UserRow, msg: Msg) => Promise<void>): Promise<void> {
    const s = this.get();
    // A slow Telegram send must not let the next minute's tick send the same reminder again.
    if (!s || this.ticking) return;
    this.ticking = true;
    try {
      await this.sendDue(s, users, grid, sendTo);
    } finally {
      this.ticking = false;
    }
  }

  private async sendDue(s: Schedule, users: UserRow[], grid: 'on' | 'off' | null, sendTo: (u: UserRow, msg: Msg) => Promise<void>): Promise<void> {
    const now = Date.now();
    const sent = new Set((this.repo.getKv<string[]>(K.sent) ?? []).filter((k) => now - Number(k.split('@')[1]) < SENT_KEEP_MS));
    let changed = false;
    for (const u of users) {
      const t = dicts[u.lang];
      for (const kind of ['off', 'on'] as const) {
        const lead = kind === 'off' ? u.remindOffMin : u.remindOnMin;
        const mine = new Set([...sent].filter((k) => k.startsWith(`${u.tgId}:`)).map((k) => k.slice(k.indexOf(':') + 1)));
        for (const r of dueReminders(s, grid, now, lead, kind, mine)) {
          sent.add(`${u.tgId}:${r.key}`);
          changed = true;
          this.repo.setKv(K.sent, [...sent]); // before sending: a crash mid-send must not repeat it
          const when = fmtTime(r.at, this.tz);
          const inMin = Math.max(1, Math.round((r.at - now) / MIN));
          const text = kind === 'off' ? t.schedule.remindOff(when, inMin) : t.schedule.remindOn(when, inMin);
          await sendTo(u, { text, silent: false }).catch((e) => log.warn('reminder not sent', errInfo(e)));
        }
      }
    }
    if (changed || sent.size !== (this.repo.getKv<string[]>(K.sent) ?? []).length) this.repo.setKv(K.sent, [...sent]);
  }
}
