import { existsSync } from 'node:fs';
import { GrammyError } from 'grammy';
import { broadcast } from './bot/notifier.js';
import { createBot, setupCommands } from './bot/bot.js';
import { dicts, LANGS } from './i18n/index.js';
import { esc, eventMsg } from './bot/format.js';
import { loadConfig } from './config.js';
import { OfficialDeyeSource } from './deye/official.js';
import type { DataSource } from './deye/types.js';
import { UnofficialDeyeSource } from './deye/unofficial.js';
import { isQuietHour } from './domain/ops.js';
import { errInfo, log, setErrorSink } from './log.js';
import { Monitor, type Send } from './monitor.js';
import { EnergyService } from './energy.js';
import { Heartbeat } from './heartbeat.js';
import { BatteryLimitsService } from './battery-limits.js';
import { ScheduleService } from './schedule/service.js';
import { BatteryHealth } from './battery-health.js';
import { Backups } from './backup.js';
import { YasnoClient } from './schedule/yasno.js';
import { powerOnTarget, tileState } from './schedule/logic.js';
import { SettingsStore, type Overrides } from './settings.js';
import { Poller } from './poller.js';
import { openDb } from './storage/db.js';
import { Repo } from './storage/repo.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env'); // local runs; Docker passes env directly
  const base = loadConfig(process.env);
  const cfg = { ...base }; // shared live config; the settings menu updates it in place
  const repo = new Repo(openDb(cfg.dbPath));
  const settings = new SettingsStore(base, cfg, () => repo.getKv<Overrides>('settings'), (o) => repo.setKv('settings', o));

  try {
    if (!repo.getUser(cfg.adminTelegramId)) {
      repo.upsertPendingUser({ tgId: cfg.adminTelegramId, name: 'Owner', username: null, lang: 'en' });
    }
    repo.setUserStatus(cfg.adminTelegramId, 'approved');
    if (!repo.getKv('watchdog_admin_default')) {
      // Owner gets "home offline" alerts by default; others opt in.
      repo.setWatchdog(cfg.adminTelegramId, true);
      repo.setKv('watchdog_admin_default', true);
    }
  } catch (e) {
    // A read-only or full disk must not crash-loop the container: run and report instead.
    log.error('startup DB write failed', errInfo(e));
  }

  const src: DataSource = cfg.deyeSource === 'unofficial' ? new UnofficialDeyeSource(cfg) : new OfficialDeyeSource(cfg);

  // Bot, poller and monitor reference each other; wire via late binding.
  let send: Send | null = null;
  let refreshPanels: (() => Promise<void>) | null = null;
  const poller = new Poller(src, repo, cfg, async (e, replayed) => {
    log.info('event', { type: e.type });
    await send?.((t) => eventMsg(e, cfg, t, replayed), 'all');
    // Open panels should show the "no fresh data" banner without a tap.
    if (e.type === 'data_stale') await refreshPanels?.();
  });
  const monitor = new Monitor(src, repo, poller, cfg, (msg, who) => send?.(msg, who) ?? Promise.resolve());

  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    monitor.stop(); // first: records the clean shutdown
    log.info('stopping');
    poller.stop();
    heartbeat.stop();
    batteryLimits.stop();
    schedule.stop();
    battery.stop();
    backups.stop();
    clearInterval(reminderTimer);
    void bot.stop().finally(() => process.exit(code));
  };

  // Docker (restart: unless-stopped) brings the bot back after exit.
  const energy = new EnergyService(src, repo, cfg);
  const heartbeat = new Heartbeat(cfg, repo, () => poller.lastAttemptAt);
  const battery = new BatteryHealth(repo, cfg);
  const backups = new Backups(cfg.dbPath, cfg.timezone, (render) => void send?.(render, 'admin'));
  const schedule = new ScheduleService(repo, new YasnoClient(), cfg.timezone, (render) => void send?.(render, 'admin'));
  const batteryLimits = new BatteryLimitsService(src);
  const { bot, panelPng, refreshLive, panelCardFor, trackLive, panelKbFor } = createBot(cfg, repo, poller, { status: (t) => monitor.status(t), restart: () => stop(0), settings, energy, watchdogEnabled: heartbeat.enabled, batteryLimits: () => batteryLimits.get(), schedule, battery });
  refreshPanels = refreshLive;
  monitor.limits = () => batteryLimits.get();
  poller.onPoll = (o) => monitor.onPoll(o);
  poller.onFresh = async (r) => {
    await monitor.onReading(r);
    await refreshLive();
  };
  // A user blocked or deleted the bot in Telegram: stop sending and tell the owner once.
  const markBlocked = (id: number) => {
    const u = repo.getUser(id);
    if (!u || u.status !== 'approved') return;
    repo.setUserStatus(id, 'blocked');
    if (id !== cfg.adminTelegramId) void send?.((t) => ({ text: t.bot.blockedOwner(esc(u.name), u.username ? esc(u.username) : null), silent: true }), 'admin');
  };
  send = async (render, who) => {
    const users = repo.approvedUsers().filter((u) => who === 'all' || u.tgId === cfg.adminTelegramId);
    const quiet = isQuietHour(Date.now(), cfg.timezone, cfg.quietFrom, cfg.quietTo);
    const total = { sent: 0, failed: 0 };
    // One rendering per language actually used.
    for (const lang of LANGS) {
      const group = users.filter((u) => u.lang === lang);
      if (!group.length) continue;
      const msg = render(dicts[lang]);
      let res: { sent: number; failed: number };
      if (msg.panel) {
        // Outage start/end: the panel itself, with its buttons, kept live like a /start panel.
        let card: ReturnType<typeof panelCardFor> | null = null;
        try {
          card = panelCardFor(lang);
        } catch (e) {
          log.error('panel render failed', errInfo(e));
        }
        res = card
          ? await broadcast(bot.api, group, { text: card.caption, fallbackText: msg.text, silent: msg.silent, photo: card.png, kb: card.kb }, markBlocked, quiet, (id, mid, asPhoto) => asPhoto && trackLive(id, mid, lang))
          : await broadcast(bot.api, group, { ...msg, kb: panelKbFor(lang) }, markBlocked, quiet);
      } else {
        // Loud household events carry the panel picture and buttons; technical and quiet ones stay plain text.
        const loud = who === 'all' && !msg.silent;
        const photo = loud ? panelPng(lang) : null;
        res = await broadcast(bot.api, group, loud ? { ...msg, ...(photo ? { photo } : {}), kb: panelKbFor(lang) } : msg, markBlocked, quiet);
      }
      total.sent += res.sent;
      total.failed += res.failed;
    }
    log.info('broadcast', { who, ...total });
  };
  setErrorSink((msg, extra) => monitor.reportError(msg, extra));

  // `on`, not `once`: npm forwards Ctrl+C, so a second SIGINT arrives while we shut down —
  // with no listener left Node would die mid-shutdown and the next start would say "after crash".
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', errInfo(e)));

  monitor.start();
  heartbeat.start();
  schedule.seedArchive(); // never throws: the archive must not stop the bot
  schedule.start();
  battery.start();
  backups.start();
  monitor.scheduleTarget = () => {
    const s = schedule.get();
    return s ? powerOnTarget(tileState(s, poller.state.grid, Date.now(), poller.state.outage?.startTs ?? null)) : null;
  };
  const reminderTimer = setInterval(() => {
    const quiet = isQuietHour(Date.now(), cfg.timezone, cfg.quietFrom, cfg.quietTo);
    void schedule
      .tickReminders(repo.approvedUsers(), poller.state.grid, async (u, msg) => {
        await broadcast(bot.api, [u], { ...msg, kb: panelKbFor(u.lang) }, markBlocked, quiet);
      })
      .catch((e) => log.warn('reminders failed', errInfo(e)));
  }, 60_000);
  // After the poller's first call has cached the Deye token.
  void poller
    .start()
    .then(() => {
      batteryLimits.start();
      return energy.warm();
    })
    .catch((e) => log.error('poller start failed', errInfo(e)));
  log.info('bot starting', { source: cfg.deyeSource });

  // grammY's own retry backs off up to 20 min when Telegram is unreachable at boot; retry faster.
  for (;;) {
    try {
      // The signal ends grammY's own retry (backoff up to 20 min) so we retry every 30 s instead.
      await bot.init(AbortSignal.timeout(30_000) as unknown as Parameters<typeof bot.init>[0]);
      break;
    } catch (e) {
      if (stopping) return;
      log.warn('telegram unreachable, retrying in 30 s', errInfo(e));
      await sleep(30_000);
    }
  }
  void setupCommands(bot, cfg.adminTelegramId, repo.approvedUsers()).catch((e) => log.warn('setMyCommands failed', errInfo(e)));

  let conflictReported = false;
  for (;;) {
    try {
      await bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] });
      return; // stopped
    } catch (e) {
      if (stopping) return;
      // 409: another instance polls with the same token. Exiting would make Docker restart-loop and fight it.
      if (!(e instanceof GrammyError && e.error_code === 409)) throw e;
      log.warn('another bot instance is polling, retrying in 60 s');
      if (!conflictReported) {
        conflictReported = true;
        void send?.((t) => ({ text: t.ops.conflict, silent: false }), 'admin');
      }
      await sleep(60_000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  log.error('fatal', errInfo(e));
  process.exit(1);
});
