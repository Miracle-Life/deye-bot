import { DateTime } from 'luxon';
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Config } from '../config.js';
import type { BatteryLimits, Interval } from '../deye/types.js';
import { buildTimeline, dayRange, dischargedKwh, minSoc, monthRange, summarize, weekRange, type Summary } from '../domain/stats.js';
import { errInfo, log } from '../log.js';
import type { Poller } from '../poller.js';
import { CARD_W, svgBattery, svgDay, svgMoney, svgPanel, svgPeriod, svgSchedule } from '../render/cards.js';
import { batteryModel, dayModel, moneyModel, panelModel, periodModel, scheduleModel, type PeriodRow } from '../render/models.js';
import { toPng } from '../render/png.js';
import type { Repo, UserRow } from '../storage/repo.js';
import { esc, renderAccessRequest, renderPanel, type PanelCtx } from './format.js';
import { accessKb, addressPicks, archiveKb, dayKb, homeKb, leaveKb, moneyKb, nextReminderLead, panelKb as basePanelKb, periodKb, restartKb, scheduleKb, settingsKb, usersKb, type PeriodNav } from './keyboards.js';
import { fieldView, homeView, sectionView, type View } from './settings-ui.js';
import { monthSummary, splitDay, type EnergyDayRaw, type Tariff } from '../domain/energy.js';
import type { EnergyService } from '../energy.js';
import { FIELDS, fieldTexts, parsePrice, type SettingsStore, type Tunable } from '../settings.js';
import { dicts, isLang, pickLang, type Dict, type Lang } from '../i18n/index.js';
import { archiveNav, archiveStats, monthDates, quarterWeeks, resolveArchiveAnchor, weekDates, type ArchiveKind } from '../schedule/archive.js';
import { isStale, tileState } from '../schedule/logic.js';
import { monthArchiveModel, quarterArchiveModel, svgArchiveMonth, svgArchiveQuarter, svgArchiveWeek, weekArchiveModel } from '../render/archive.js';
import type { ScheduleService } from '../schedule/service.js';
import type { BatteryHealth } from '../battery-health.js';

const DAY = 86_400_000;
const HISTORY_MS = 90 * DAY;
const LIVE_MS = 15 * 60_000; // a panel keeps refreshing itself this long after the last tap

interface Card {
  png: Buffer;
  caption: string;
  kb: InlineKeyboard;
  live?: boolean; // panel card: refresh in place when new data arrives
}

export interface DeyeBot {
  bot: Bot;
  /** Current panel as PNG for notifications; null if rendering fails. */
  panelPng(lang: Lang): Buffer | null;
  /** Re-renders panels users looked at recently. */
  refreshLive(): Promise<void>;
  /** The panel exactly as /start shows it (notifications for outage start/end). Throws if rendering fails. */
  panelCardFor(lang: Lang): { png: Buffer; caption: string; kb: InlineKeyboard };
  /** Makes a sent message that chat's live panel. */
  trackLive(chatId: number, messageId: number, lang: Lang): void;
  /** Panel buttons, for notifications. */
  panelKbFor(lang: Lang): InlineKeyboard;
}

/** Services provided by main. */
export interface BotOps {
  status(t: Dict): string;
  restart(): void;
  settings: SettingsStore;
  energy: EnergyService;
  watchdogEnabled: boolean;
  batteryLimits: () => BatteryLimits | null;
  schedule: ScheduleService;
  battery: BatteryHealth;
}

const INPUT_TTL_MS = 5 * 60_000;
const REFRESH_WAIT_MS = 10_000;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

const notModified = (e: unknown) => e instanceof GrammyError && e.description.includes('message is not modified');

/** Runs `fn` unless a previous run is still going (a slow Telegram must not stack refreshes). */
export function oneAtATime(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => (running ??= fn().finally(() => (running = null)));
}

/** A notification may have become this chat's live panel while the old one was being edited: keep it. */
export function dropLive(live: Map<number, { messageId: number }>, chatId: number, messageId: number): void {
  if (live.get(chatId)?.messageId === messageId) live.delete(chatId);
}

export function createBot(cfg: Config, repo: Repo, poller: Poller, ops: BotOps): DeyeBot {
  // grammY's default 500 s API timeout could stall polling on a dead connection; stay above the 30 s long poll.
  const bot = new Bot(cfg.telegramToken, { client: { timeoutSeconds: 60 } });
  const isAdmin = (id: number) => id === cfg.adminTelegramId;
  /** Stored choice; people without a row yet get their Telegram language. */
  const langOf = (id: number, code?: string): Lang => repo.getUser(id)?.lang ?? pickLang(code);
  const tOf = (id: number, code?: string): Dict => dicts[langOf(id, code)];
  const tCtx = (ctx: Context): Dict => tOf(ctx.from!.id, ctx.from?.language_code);

  const settingsText = (u: UserRow | null, t: Dict) =>
    [
      t.bot.language(t.langName),
      t.bot.sound(u?.muted ? t.common.off : t.common.on),
      t.bot.night(u?.nightQuiet ? t.common.on : t.common.off),
      t.bot.nightNote(hh(cfg.quietFrom), hh(cfg.quietTo)),
      ...(ops.watchdogEnabled ? [t.bot.watch(u?.watchdog ? t.common.on : t.common.off), t.bot.watchNote] : []),
    ].join('\n');
  const userSettings = (id: number): View => {
    const u = repo.getUser(id);
    const lang = u?.lang ?? 'en';
    const t = dicts[lang];
    const reminders = u && ops.schedule.address() ? { off: u.remindOffMin, on: u.remindOnMin } : null;
    return { text: settingsText(u, t), kb: settingsKb(!!u?.muted, !!u?.nightQuiet, isAdmin(id), ops.watchdogEnabled ? !!u?.watchdog : null, lang, t, reminders) };
  };
  // Owner is typing something: a price for a setting, or a street / house for the schedule address.
  type Pending = { kind: 'price'; key: Tunable } | { kind: 'street' } | { kind: 'house'; streetId: number; street: string };
  const pendingInput = new Map<number, Pending & { until: number }>();
  // Names behind the street/house buttons (callback data only carries ids).
  const pickNames = new Map<string, string>();
  // The owner's last YASNO search, for paging through more than 10 results.
  let lastPicks: { kind: 'street' | 'house'; opts: { id: number; name: string }[] } | null = null;
  const addressLine = (t: Dict) => {
    const a = ops.schedule.address();
    return a ? t.addr.current(esc(a.street), esc(a.house), a.group) : t.addr.none;
  };
  const z = cfg.timezone;
  const today = () => DateTime.now().setZone(z).toISODate()!;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // --- data → cards -------------------------------------------------------

  function scheduleCtx(nowMs: number): PanelCtx['schedule'] {
    const sch = ops.schedule.get();
    const state = sch ? tileState(sch, poller.state.grid, nowMs, poller.state.outage?.startTs ?? null, repo.lastClosedOutage()?.end ?? null) : null;
    if (!sch || !state) return null;
    // Same 15-min average as the "may not last" warning, so the two agree.
    const d = repo
      .readingsBetween(nowMs - 15 * 60_000, nowMs + 1)
      .map((x) => x.batteryPowerW)
      .filter((w): w is number => w !== null && w < 0);
    const dischargeW = d.length ? -d.reduce((a, b) => a + b, 0) / d.length : null;
    return { state, stale: isStale(sch, nowMs), fetchedAt: sch.fetchedAt, dischargeW };
  }

  function panelCtx(): PanelCtx {
    const s = poller.state;
    const last = repo.lastClosedOutage();
    return {
      schedule: scheduleCtx(Date.now()),
      reading: repo.latestReading(),
      grid: s.grid === null ? null : { state: s.grid, missingPhases: s.outage?.missingPhases ?? [], ambiguous: false },
      outageStartTs: s.outage?.startTs ?? null,
      lastOnTs: last?.end ?? null,
      lastOutageStartTs: last?.start ?? null,
      nowMs: Date.now(),
      staleAfterMs: cfg.staleAfterMin * 60_000,
      limits: ops.batteryLimits(),
    };
  }

  // "🗓 Schedule" under the panel only once an address is set.
  const panelKb = (t: Dict) => basePanelKb(t, ops.schedule.address() !== null);

  function scheduleCard(t: Dict): Card | null {
    const sch = ops.schedule.get();
    if (!sch) return null;
    const now = Date.now();
    // Before the first poll there is no grid state yet; the card is about the schedule anyway.
    const state = tileState(sch, poller.state.grid ?? 'on', now, poller.state.outage?.startTs ?? null, repo.lastClosedOutage()?.end ?? null)!;
    const m = scheduleModel(sch, state, isStale(sch, now), now, cfg, t);
    return { png: toPng(svgSchedule(m), CARD_W), caption: m.caption, kb: scheduleKb(t) };
  }

  /** Past schedules: week / month / 3 months. */
  function archiveCard(kind: ArchiveKind, raw: string, t: Dict): Card {
    const now = Date.now();
    const oldest = repo.oldestScheduleDate();
    const anchor = resolveArchiveAnchor(kind, raw, oldest, today(), z);
    const weeks = kind === 'q' ? quarterWeeks(anchor, z) : null;
    const dates = weeks ? weeks.flat() : kind === 'w' ? weekDates(anchor, z) : monthDates(anchor, z);
    const archived = repo.scheduleDaysBetween(dates[0]!, dates.at(-1)!);
    const from = dayRange(dates[0]!, z).from;
    const to = dayRange(dates.at(-1)!, z).to;
    const stats = archiveStats(dates, new Map(archived.map((d) => [d.date, d])), repo.outagesOverlapping(from, to), unknownIntervals(from, to, now), now, z, repo.earliestDataTs());
    const group = archived.at(-1)?.group ?? ops.schedule.address()?.group ?? null;
    const kb = archiveKb(kind, archiveNav(kind, anchor, oldest, today(), z), t);
    if (kind === 'w') {
      const m = weekArchiveModel(stats, group, now, cfg, t);
      return { png: toPng(svgArchiveWeek(m), CARD_W), caption: m.caption, kb };
    }
    if (kind === 'm') {
      const m = monthArchiveModel(stats, anchor, group, now, cfg, t);
      return { png: toPng(svgArchiveMonth(m), CARD_W), caption: m.caption, kb };
    }
    const m = quarterArchiveModel(weeks!.map((_, i) => stats.slice(i * 7, i * 7 + 7)), group, now, cfg, t);
    return { png: toPng(svgArchiveQuarter(m), CARD_W), caption: m.caption, kb };
  }

  function panelCard(t: Dict): Card {
    const m = panelModel(panelCtx(), cfg, t);
    return { png: toPng(svgPanel(m), CARD_W), caption: m.caption, kb: panelKb(t), live: true };
  }

  // One live panel per chat: the last one the user opened or refreshed.
  const live = new Map<number, { messageId: number; until: number; lang: Lang }>();

  function track(chatId: number, messageId: number, isPanel: boolean, lang: Lang): void {
    if (isPanel) live.set(chatId, { messageId, until: Date.now() + LIVE_MS, lang });
    else if (live.get(chatId)?.messageId === messageId) live.delete(chatId);
  }

  const refreshLive = oneAtATime(refreshLiveOnce);

  async function refreshLiveOnce(): Promise<void> {
    if (!live.size) return;
    const cards = new Map<Lang, Card>(); // render each language once per refresh
    for (const [chatId, p] of live) {
      if (p.until < Date.now()) {
        live.delete(chatId);
        continue;
      }
      let card = cards.get(p.lang);
      if (!card) {
        card = panelCard(dicts[p.lang]);
        cards.set(p.lang, card);
      }
      try {
        await bot.api.editMessageMedia(
          chatId,
          p.messageId,
          { type: 'photo', media: new InputFile(card.png, 'card.png'), caption: card.caption, parse_mode: 'HTML' },
          { reply_markup: card.kb },
        );
      } catch (e) {
        if (notModified(e)) continue;
        // Drop only when the message is gone or the user blocked us; keep it on 429 / network errors.
        if (e instanceof GrammyError && e.error_code !== 429) dropLive(live, chatId, p.messageId);
        log.warn('live panel refresh failed', errInfo(e));
      }
    }
  }

  /** Gaps plus "no data" before the first reading and during current silence. */
  function unknownIntervals(from: number, to: number, now: number): Interval[] {
    const gaps = repo.gapsOverlapping(from, to);
    const earliest = repo.earliestDataTs();
    if (earliest === null || earliest > from) gaps.push({ start: from, end: earliest ?? now });
    const s = poller.state;
    if (s.stale && s.staleSinceTs !== null) gaps.push({ start: s.staleSinceTs, end: now });
    return gaps;
  }

  function summaryFor(from: number, to: number, now: number): Summary {
    const outages = repo.outagesOverlapping(from, to);
    return summarize(buildTimeline(from, to, outages, unknownIntervals(from, to, now), now), outages, from, to);
  }

  const minAllowed = () => DateTime.now().setZone(z).minus({ milliseconds: HISTORY_MS }).startOf('day').toMillis();

  function nav(prevRange: { from: number; to: number }, nextRange: { from: number; to: number }, prev: string, next: string): PeriodNav {
    return { prev: prevRange.to > minAllowed() ? prev : null, next: nextRange.from <= Date.now() ? next : null };
  }

  function dayCard(dateIso: string, t: Dict): Card {
    const now = Date.now();
    const range = dayRange(dateIso, z);
    const outages = repo.outagesOverlapping(range.from, range.to);
    const segs = buildTimeline(range.from, range.to, outages, unknownIntervals(range.from, range.to, now), now);
    const readings = repo.readingsBetween(range.from, range.to);
    const m = dayModel(
      dateIso,
      segs,
      summarize(segs, outages, range.from, range.to),
      outages,
      minSoc(readings),
      dischargedKwh(readings, cfg.staleAfterMin * 60_000),
      cfg,
      range,
      now,
      repo.earliestDataTs(),
      t,
    );
    const d = DateTime.fromISO(dateIso, { zone: z });
    const prevIso = d.minus({ days: 1 }).toISODate()!;
    const nextIso = d.plus({ days: 1 }).toISODate()!;
    return {
      png: toPng(svgDay(m), CARD_W),
      caption: m.caption,
      kb: dayKb(dateIso, nav(dayRange(prevIso, z), dayRange(nextIso, z), `s:d:${prevIso}`, `s:d:${nextIso}`), z, t),
    };
  }

  function weekCard(anyIso: string, t: Dict): Card {
    const now = Date.now();
    const w = weekRange(anyIso, z);
    const start = DateTime.fromMillis(w.from, { zone: z }).setLocale(t.locale);
    const rows: PeriodRow[] = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }))
      .filter((d) => d.toMillis() <= now)
      .map((d) => {
        const r = dayRange(d.toISODate()!, z);
        return { label: cap(d.toFormat('ccc dd')), sum: summaryFor(r.from, r.to, now), spanMs: r.to - r.from };
      });
    const total = summaryFor(w.from, w.to, now);
    // Compare with the same elapsed span of last week.
    const span = Math.min(now, w.to) - w.from;
    const prevFrom = start.minus({ weeks: 1 }).toMillis();
    const prevTotal = prevFrom >= minAllowed() ? summaryFor(prevFrom, prevFrom + span, now) : null;
    const m = periodModel(`${start.toFormat('d MMM')} – ${start.plus({ days: 6 }).toFormat('d MMM')}`, rows, total, prevTotal, cfg, t);
    const mondayIso = start.toISODate()!;
    const prevIso = start.minus({ weeks: 1 }).toISODate()!;
    const nextIso = start.plus({ weeks: 1 }).toISODate()!;
    return {
      png: toPng(svgPeriod(m), CARD_W),
      caption: m.caption,
      kb: periodKb('w', mondayIso, nav(weekRange(prevIso, z), weekRange(nextIso, z), `s:w:${prevIso}`, `s:w:${nextIso}`), t),
    };
  }

  function monthCard(monthIso: string, t: Dict): Card {
    const now = Date.now();
    const mr = monthRange(`${monthIso}-01`, z);
    const rows: PeriodRow[] = [];
    let cur = DateTime.fromMillis(mr.from, { zone: z });
    while (cur.toMillis() < mr.to && cur.toMillis() <= now) {
      const weekEnd = DateTime.min(cur.startOf('week').plus({ weeks: 1 }), DateTime.fromMillis(mr.to, { zone: z }));
      rows.push({
        label: `${cur.toFormat('dd')}–${weekEnd.minus({ days: 1 }).toFormat('dd')}`,
        sum: summaryFor(cur.toMillis(), weekEnd.toMillis(), now),
        spanMs: weekEnd.toMillis() - cur.toMillis(),
      });
      cur = weekEnd;
    }
    const start = DateTime.fromMillis(mr.from, { zone: z }).setLocale(t.locale);
    const prev = start.minus({ months: 1 }).toFormat('yyyy-MM');
    const next = start.plus({ months: 1 }).toFormat('yyyy-MM');
    const m = periodModel(cap(start.toFormat('LLLL yyyy')), rows, summaryFor(mr.from, mr.to, now), null, cfg, t);
    return {
      png: toPng(svgPeriod(m), CARD_W),
      caption: m.caption.replace('📅', '🗓'),
      kb: periodKb('m', monthIso, nav(monthRange(`${prev}-01`, z), monthRange(`${next}-01`, z), `s:m:${prev}`, `s:m:${next}`), t),
    };
  }

  const tariff = (): Tariff => ({ dayPrice: cfg.tariffDay, nightPrice: cfg.tariffNight, nightFrom: cfg.tariffNightFrom, nightTo: cfg.tariffNightTo });
  const thisMonth = () => today().slice(0, 7);

  function moneyCard(monthIso: string, raw: EnergyDayRaw[], t: Dict): Card {
    const now = Date.now();
    const tr = tariff();
    const days = raw.map((d) => splitDay(d, tr));
    const earliest = repo.earliestDataTs();
    const m = moneyModel(monthSummary(days, tr, monthIso, now, z, earliest), monthIso, tr, days, now, cfg, t);
    const start = DateTime.fromISO(`${monthIso}-01`, { zone: z });
    const prev = start.minus({ months: 1 }).toFormat('yyyy-MM');
    const next = start.plus({ months: 1 }).toFormat('yyyy-MM');
    return {
      png: toPng(svgMoney(m), CARD_W),
      caption: m.caption,
      kb: moneyKb(nav(monthRange(`${prev}-01`, z), monthRange(`${next}-01`, z), `e:${prev}`, `e:${next}`), t),
    };
  }

  // --- telegram helpers ---------------------------------------------------

  async function edit(ctx: Context, text: string, kb?: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e) {
      if (notModified(e)) return;
      throw e;
    }
  }

  /** Replaces the photo in place; falls back to a new message (e.g. old text panels). */
  async function showCard(ctx: Context, make: (t: Dict) => Card | Promise<Card>): Promise<void> {
    const lang = langOf(ctx.from!.id, ctx.from?.language_code);
    const t = dicts[lang];
    let card: Card;
    try {
      card = await make(t);
    } catch (e) {
      log.error('render failed', errInfo(e));
      await ctx.reply(renderPanel(panelCtx(), cfg, t), { parse_mode: 'HTML', reply_markup: panelKb(t) });
      return;
    }
    const chatId = ctx.chat!.id;
    const msgId = ctx.callbackQuery?.message?.message_id;
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: new InputFile(card.png, 'card.png'), caption: card.caption, parse_mode: 'HTML' },
        { reply_markup: card.kb },
      );
      if (msgId) track(chatId, msgId, !!card.live, lang);
    } catch (e) {
      // Same picture as before: nothing to do (never post a duplicate).
      if (notModified(e)) {
        if (msgId) track(chatId, msgId, !!card.live, lang);
        return;
      }
      if (!(e instanceof GrammyError)) throw e;
      if (e.error_code === 429) return void log.warn('card edit rate-limited', errInfo(e)); // a new photo would only duplicate
      if (e.error_code !== 400) throw e;
      // Message can't hold a photo (old text panel) — send a fresh one.
      const m = await ctx.replyWithPhoto(new InputFile(card.png, 'card.png'), { caption: card.caption, parse_mode: 'HTML', reply_markup: card.kb });
      track(chatId, m.message_id, !!card.live, lang);
    }
  }

  // Toasts stay under ~40 chars: iOS shows a single truncated line.

  /** Refresh found no new frame yet; the live panel updates itself later. */
  function waitToast(t: Dict): string {
    const next = poller.nextFrameAt();
    return next !== null && next > Date.now() + 30_000 ? t.bot.newDataAt(DateTime.fromMillis(next, { zone: z }).toFormat('HH:mm')) : t.bot.newDataSoon;
  }

  /** Refresh failed: the bot is fine, Deye is not. */
  function cloudErrorToast(t: Dict): string {
    const last = repo.latestReading();
    return last ? t.bot.deyeSilentSince(DateTime.fromMillis(last.ts, { zone: z }).toFormat('HH:mm')) : t.bot.deyeSilent;
  }

  async function sendPanel(chatId: number): Promise<void> {
    const lang = langOf(chatId);
    const t = dicts[lang];
    try {
      const c = panelCard(t);
      const m = await bot.api.sendPhoto(chatId, new InputFile(c.png, 'panel.png'), { caption: c.caption, parse_mode: 'HTML', reply_markup: c.kb });
      track(chatId, m.message_id, true, lang);
    } catch (e) {
      log.error('panel photo failed', errInfo(e));
      await bot.api.sendMessage(chatId, renderPanel(panelCtx(), cfg, t), { parse_mode: 'HTML', reply_markup: panelKb(t) });
    }
  }

  const displayName = (ctx: Context, t: Dict) => [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || t.common.noName;

  function approved(id: number): boolean {
    return isAdmin(id) || repo.getUser(id)?.status === 'approved';
  }

  // --- middleware & handlers ----------------------------------------------

  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return; // private chats only
    await next();
  });

  bot.command('start', async (ctx) => {
    const id = ctx.from!.id;
    const picked = pickLang(ctx.from?.language_code);
    const user = repo.upsertPendingUser({ tgId: id, name: displayName(ctx, dicts[picked]), username: ctx.from?.username ?? null, lang: picked });
    const t = dicts[user.lang];
    if (isAdmin(id) && user.status !== 'approved') repo.setUserStatus(id, 'approved');
    if (approved(id)) return void (await sendPanel(id));

    if (user.status === 'blocked') {
      // Was approved, blocked the bot, came back.
      repo.setUserStatus(id, 'approved');
      return void (await sendPanel(id));
    }
    if (user.status === 'rejected') return void (await ctx.reply(t.bot.rejected));
    const fresh = user.createdAt > Date.now() - 5_000;
    await ctx.reply(fresh ? t.bot.requestSent : t.bot.requestPending);
    if (user.status === 'pending' && fresh) {
      const ta = tOf(cfg.adminTelegramId);
      await bot.api.sendMessage(cfg.adminTelegramId, renderAccessRequest(user.name, user.username, ta), {
        parse_mode: 'HTML',
        reply_markup: accessKb(id, ta),
      });
    }
  });

  // Everything below requires access.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !approved(id)) {
      const t = dicts[pickLang(ctx.from?.language_code)];
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t.bot.noAccess });
      else await ctx.reply(t.bot.inviteOnly);
      return;
    }
    await next();
  });

  bot.command('settings', async (ctx) => {
    const v = userSettings(ctx.from!.id);
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
  });

  /**
   * Loads a month of energy days. Uncached months can take a while (one Deye request per day),
   * and grammY handles updates one by one — so that work runs detached from the update.
   */
  async function withMonth(ctx: Context, monthIso: string, show: (raw: EnergyDayRaw[]) => Promise<void>): Promise<void> {
    const run = async () => {
      let raw: EnergyDayRaw[];
      try {
        raw = await ops.energy.month(monthIso);
      } catch (e) {
        log.warn('money card failed', errInfo(e));
        await ctx.reply(tCtx(ctx).bot.moneyLater).catch(() => {});
        return;
      }
      await show(raw);
    };
    if (ops.energy.cached(monthIso)) return run();
    void run().catch((e) => log.error('money card failed', errInfo(e)));
  }

  bot.command('money', async (ctx) => {
    const t = tCtx(ctx);
    if (!ops.energy.supported) return void (await ctx.reply(t.bot.noEnergy));
    const m = thisMonth();
    if (!ops.energy.cached(m)) await ctx.replyWithChatAction('upload_photo').catch(() => {});
    await withMonth(ctx, m, async (raw) => {
      const c = moneyCard(m, raw, t);
      await ctx.replyWithPhoto(new InputFile(c.png, 'money.png'), { caption: c.caption, parse_mode: 'HTML', reply_markup: c.kb });
    });
  });

  bot.command('battery', async (ctx) => {
    const t = tCtx(ctx);
    const m = batteryModel(ops.battery.data(), t);
    await ctx.replyWithPhoto(new InputFile(toPng(svgBattery(m), CARD_W), 'battery.png'), {
      caption: m.caption,
      parse_mode: 'HTML',
      reply_markup: homeKb(t),
    });
  });

  bot.command('schedule', async (ctx) => {
    const t = tCtx(ctx);
    if (!ops.schedule.address()) return void (await ctx.reply(t.schedule.noAddress));
    const c = scheduleCard(t);
    if (!c) return void (await ctx.reply(t.schedule.noData));
    await ctx.replyWithPhoto(new InputFile(c.png, 'schedule.png'), { caption: c.caption, parse_mode: 'HTML', reply_markup: c.kb });
  });

  bot.command('status', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    await ctx.reply(ops.status(tCtx(ctx)), { parse_mode: 'HTML', reply_markup: homeKb(tCtx(ctx)) });
  });

  bot.command('restart', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    const t = tCtx(ctx);
    await ctx.reply(t.bot.restartAsk, { reply_markup: restartKb(t) });
  });

  const usersText = (users: UserRow[], t: Dict) =>
    [
      t.bot.usersTitle,
      ...users.map((u) => `${esc(u.name)}${u.username ? ` (@${esc(u.username)})` : ''} · ${t.bot.userStatus[u.status]}${isAdmin(u.tgId) ? ` · ${t.bot.owner}` : ''}`),
    ].join('\n');

  bot.command('users', async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    const t = tCtx(ctx);
    const users = repo.listUsers();
    await ctx.reply(usersText(users, t), { parse_mode: 'HTML', reply_markup: usersKb(users, cfg.adminTelegramId, t) });
  });

  // Typed price for the settings menu.
  bot.on('message:text', async (ctx, next) => {
    const p = pendingInput.get(ctx.from.id);
    if (!p || ctx.message.text.startsWith('/')) return next();
    if (p.until < Date.now()) {
      pendingInput.delete(ctx.from.id);
      return next();
    }
    const t = tCtx(ctx);
    // Detached: a slow YASNO search must not hold up everyone's updates.
    if (p.kind !== 'price') return void addressInput(ctx, p, ctx.message.text.trim(), t).catch((e) => log.warn('address input failed', errInfo(e)));
    const f = FIELDS.find((x) => x.key === p.key)!;
    const price = parsePrice(ctx.message.text);
    if (price === null) return void (await ctx.reply(t.bot.badPrice, { parse_mode: 'HTML' }));
    pendingInput.delete(ctx.from.id);
    ops.settings.set(p.key, price as never);
    const v = fieldView(ops.settings, f, t, t.bot.saved);
    await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
  });

  async function settingsCallback(ctx: Context, a: string | undefined, b: string | undefined, c: string | undefined, t: Dict): Promise<string | undefined> {
    const st = ops.settings;
    const f = FIELDS.find((x) => x.key === b);
    const show = (v: View | null) => (v ? edit(ctx, v.text, v.kb) : Promise.resolve());
    if (a === 'home') return void (await show(homeView(st, t, addressLine(t))));
    if (a === 's' && b) return void (await show(sectionView(st, b, t)));
    if (!f) return;
    if (a === 'f') return void (await show(fieldView(st, f, t)));
    if (a === 'v') {
      const value = c === 'null' ? null : Number(c);
      if (!st.set(f.key, value as never)) return t.bot.badValue;
      await show(fieldView(st, f, t));
      return t.bot.saved;
    }
    if (a === 't') {
      const cur = new Set(st.get(f.key) as number[]);
      const o = Number(c);
      if (cur.has(o)) cur.delete(o);
      else cur.add(o);
      st.set(f.key, [...cur] as never);
      await show(fieldView(st, f, t));
      return;
    }
    if (a === 'r') {
      st.reset(f.key);
      await show(fieldView(st, f, t));
      return t.bot.resetDone;
    }
    if (a === 'i') {
      pendingInput.set(ctx.from!.id, { kind: 'price', key: f.key, until: Date.now() + INPUT_TTL_MS });
      await ctx.reply(t.bot.typePrice(fieldTexts(f, t).label.toLowerCase()), { parse_mode: 'HTML' });
      return;
    }
  }

  /** Owner typed a street or a house number: offer matches as buttons. */
  async function addressInput(ctx: Context, p: Pending, text: string, t: Dict): Promise<void> {
    let opts: { id: number; name: string }[];
    try {
      opts = p.kind === 'street' ? await ops.schedule.searchStreets(text) : p.kind === 'house' ? await ops.schedule.searchHouses(p.streetId, text) : [];
    } catch (e) {
      log.warn('address search failed', errInfo(e));
      return void (await ctx.reply(t.addr.failed));
    }
    if (!opts.length) return void (await ctx.reply(t.addr.notFound));
    lastPicks = { kind: p.kind === 'street' ? 'street' : 'house', opts };
    const picks = addressPicks(opts, lastPicks.kind, t);
    for (const [k, v] of picks.names) pickNames.set(k, v);
    await ctx.reply(picks.text, { reply_markup: picks.kb });
  }

  async function addressCallback(ctx: Context, a: string | undefined, b: string | undefined, t: Dict): Promise<string | undefined> {
    const id = ctx.from!.id;
    const until = Date.now() + INPUT_TTL_MS;
    if (a === 'start') {
      pendingInput.set(id, { kind: 'street', until });
      await ctx.reply(t.addr.askStreet);
      return;
    }
    if (a === 'pg' && b && lastPicks) {
      const picks = addressPicks(lastPicks.opts, lastPicks.kind, t, Number(b));
      for (const [k, v] of picks.names) pickNames.set(k, v);
      await edit(ctx, picks.text, picks.kb);
      return;
    }
    if (a === 'st' && b) {
      const street = pickNames.get(`adr:st:${b}`) ?? b;
      pendingInput.set(id, { kind: 'house', streetId: Number(b), street, until });
      await ctx.reply(t.addr.askHouse(street));
      return;
    }
    const p = pendingInput.get(id);
    if (a === 'h' && b && p?.kind === 'house') {
      const houseId = Number(b);
      const house = pickNames.get(`adr:h:${b}`) ?? b;
      pendingInput.delete(id);
      // Detached for the same reason as the search.
      void (async () => {
        try {
          const group = await ops.schedule.groupOf(p.streetId, houseId);
          ops.schedule.setAddress({ streetId: p.streetId, street: p.street, houseId, house, group });
          await ctx.reply(t.addr.saved(esc(p.street), esc(house), group), { parse_mode: 'HTML' });
        } catch (e) {
          log.warn('address save failed', errInfo(e));
          await ctx.reply(t.addr.failed).catch(() => {});
        }
      })();
    }
  }

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [kind, a, b, c] = data.split(':');
    const t = tCtx(ctx);
    let toast: string | undefined;
    try {
      if (kind === 'v') {
        await showCard(ctx, panelCard);
      } else if (kind === 'r') {
        const before = repo.latestReading()?.ts;
        // Don't block every user's updates behind a slow backfill or a broadcast waiting out a 429.
        await Promise.race([poller.pollNow(), new Promise((r) => setTimeout(r, REFRESH_WAIT_MS))]);
        await showCard(ctx, panelCard);
        const fresh = repo.latestReading()?.ts !== before;
        toast = fresh ? t.bot.refreshed : poller.lastError ? cloudErrorToast(t) : waitToast(t);
      } else if (kind === 'sch') {
        if (!ops.schedule.address()) toast = t.schedule.noAddress.slice(0, 60);
        else {
          if (a === 'refresh') {
            // Bounded like the panel refresh: grammY handles updates one by one.
            const res = await Promise.race([ops.schedule.refresh(true), new Promise<'failed'>((r) => setTimeout(() => r('failed'), REFRESH_WAIT_MS))]);
            toast = res === 'ok' ? t.bot.refreshed : res === 'limited' ? t.schedule.tooOften : t.schedule.fetchFailed;
          }
          if (ops.schedule.get()) await showCard(ctx, (tt) => scheduleCard(tt)!);
          else toast = t.schedule.noData;
        }
      } else if (kind === 'sa' && (a === 'w' || a === 'm' || a === 'q')) {
        if (!ops.schedule.address()) toast = t.schedule.noAddress.slice(0, 60);
        else await showCard(ctx, (tt) => archiveCard(a, b ?? 'now', tt));
      } else if (kind === 'e') {
        const m = a === 'now' || !a ? thisMonth() : a;
        if (!ops.energy.cached(m)) toast = t.bot.countingMoney;
        await withMonth(ctx, m, (raw) => showCard(ctx, (tt) => moneyCard(m, raw, tt)));
      } else if (kind === 'adr' && isAdmin(ctx.from.id)) {
        toast = await addressCallback(ctx, a, b, t);
      } else if (kind === 'cfg' && isAdmin(ctx.from.id)) {
        toast = await settingsCallback(ctx, a, b, c, t);
      } else if (kind === 'set' && a === 'home') {
        const v = userSettings(ctx.from.id);
        await edit(ctx, v.text, v.kb);
      } else if (kind === 's' && a === 'd') {
        const iso = b === 'today' || !b ? today() : b;
        await showCard(ctx, (tt) => dayCard(iso, tt));
      } else if (kind === 's' && a === 'w' && b) {
        await showCard(ctx, (tt) => weekCard(b, tt));
      } else if (kind === 's' && a === 'm' && b) {
        await showCard(ctx, (tt) => monthCard(b, tt));
      } else if (kind === 'u' && isAdmin(ctx.from.id) && b) {
        const target = Number(b);
        const u = repo.getUser(target);
        if (a === 'ok' && u) {
          repo.setUserStatus(target, 'approved');
          await edit(ctx, t.bot.granted(esc(u.name)));
          // The user may have blocked the bot meanwhile: still set up what we can.
          await bot.api.sendMessage(target, dicts[u.lang].bot.welcome).catch((e) => log.warn('welcome not sent', errInfo(e)));
          await setupUserCommands(bot, u, false);
          await sendPanel(target).catch((e) => log.warn('panel not sent', errInfo(e)));
        } else if (a === 'no' && u) {
          repo.setUserStatus(target, 'rejected');
          await edit(ctx, t.bot.rejectedName(esc(u.name)));
        } else if (a === 'del' && target !== cfg.adminTelegramId) {
          repo.deleteUser(target);
          const users = repo.listUsers();
          await edit(ctx, usersText(users, t), usersKb(users, cfg.adminTelegramId, t));
        }
      } else if (kind === 'set' && a === 'mute') {
        const u = repo.getUser(ctx.from.id);
        repo.setMuted(ctx.from.id, !u?.muted);
        const v = userSettings(ctx.from.id);
        await edit(ctx, v.text, v.kb);
      } else if (kind === 'set' && a === 'watch') {
        const u = repo.getUser(ctx.from.id);
        repo.setWatchdog(ctx.from.id, !u?.watchdog);
        const v = userSettings(ctx.from.id);
        await edit(ctx, v.text, v.kb);
      } else if (kind === 'set' && a === 'lang' && isLang(b)) {
        repo.setLang(ctx.from.id, b);
        const open = live.get(ctx.chat!.id);
        if (open) open.lang = b; // the live panel switches on its next refresh
        const v = userSettings(ctx.from.id);
        await edit(ctx, v.text, v.kb);
        const u = repo.getUser(ctx.from.id);
        if (u) await setupUserCommands(bot, u, isAdmin(u.tgId));
      } else if (kind === 'set' && a === 'rem' && (b === 'off' || b === 'on')) {
        const u = repo.getUser(ctx.from.id);
        if (u) repo.setReminder(ctx.from.id, b, nextReminderLead(b === 'off' ? u.remindOffMin : u.remindOnMin));
        const v = userSettings(ctx.from.id);
        await edit(ctx, v.text, v.kb);
      } else if (kind === 'set' && a === 'leave' && !isAdmin(ctx.from.id)) {
        if (b === 'yes') {
          const id = ctx.from.id;
          const u = repo.getUser(id);
          repo.deleteUser(id);
          live.delete(ctx.chat!.id);
          pendingInput.delete(id);
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(t.bot.leftUser).catch(() => {});
          // Back to the default menu for this chat (the per-user one listed commands they can't use now).
          await bot.api.deleteMyCommands({ scope: { type: 'chat', chat_id: id } }).catch(() => {});
          if (u) {
            const ta = tOf(cfg.adminTelegramId);
            await bot.api
              .sendMessage(cfg.adminTelegramId, ta.bot.leftOwner(esc(u.name), u.username ? esc(u.username) : null), { parse_mode: 'HTML' })
              .catch((e) => log.warn('leave notice failed', errInfo(e)));
          }
        } else {
          await edit(ctx, t.bot.leaveAsk, leaveKb(t));
        }
      } else if (kind === 'set' && a === 'night') {
        const u = repo.getUser(ctx.from.id);
        repo.setNightQuiet(ctx.from.id, !u?.nightQuiet);
        const v = userSettings(ctx.from.id);
        await edit(ctx, v.text, v.kb);
      } else if (kind === 'sys' && isAdmin(ctx.from.id)) {
        if (a === 'restart') {
          await edit(ctx, t.bot.restarting);
          // Let Telegram get the callback answer first.
          setTimeout(() => ops.restart(), 500);
        } else {
          await edit(ctx, t.bot.restartCancelled);
        }
      }
    } finally {
      await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {});
    }
  });

  bot.catch((err) => log.error('bot error', errInfo(err.error)));

  return {
    bot,
    panelPng: (lang) => {
      try {
        return panelCard(dicts[lang]).png;
      } catch (e) {
        log.error('panel render failed', errInfo(e));
        return null;
      }
    },
    refreshLive,
    panelCardFor: (lang) => panelCard(dicts[lang]),
    trackLive: (chatId, messageId, lang) => track(chatId, messageId, true, lang),
    panelKbFor: (lang) => panelKb(dicts[lang]),
  };
}

function commandsFor(t: Dict, admin: boolean) {
  const base = [
    { command: 'start', description: t.cmd.start },
    { command: 'money', description: t.cmd.money },
    { command: 'schedule', description: t.cmd.schedule },
    { command: 'battery', description: t.cmd.battery },
    { command: 'settings', description: t.cmd.settings },
  ];
  if (!admin) return base;
  return [
    ...base,
    { command: 'users', description: t.cmd.users },
    { command: 'status', description: t.cmd.status },
    { command: 'restart', description: t.cmd.restart },
  ];
}

/** Command menu of one chat in that user's language. */
export async function setupUserCommands(bot: Bot, u: UserRow, admin: boolean): Promise<void> {
  await bot.api
    .setMyCommands(commandsFor(dicts[u.lang], admin), { scope: { type: 'chat', chat_id: u.tgId } })
    .catch((e) => log.warn('chat commands not set', { tgId: u.tgId, ...errInfo(e) }));
}

/** Defaults by Telegram app language (English otherwise), then each approved user's own choice. */
export async function setupCommands(bot: Bot, adminId: number, users: UserRow[]): Promise<void> {
  await bot.api.setMyCommands(commandsFor(dicts.en, false));
  for (const l of ['uk', 'ru'] as const) await bot.api.setMyCommands(commandsFor(dicts[l], false), { language_code: l });
  for (const u of users) if (u.status === 'approved') await setupUserCommands(bot, u, u.tgId === adminId);
}
