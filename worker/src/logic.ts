// Pure decisions of the watchdog: when to say "home offline" and "back online".

// Same set as the bot's languages (separate build, so a copy).
export type Lang = 'uk' | 'ru' | 'en';
const LANGS: Lang[] = ['uk', 'ru', 'en'];

export interface Chat {
  id: number;
  muted: boolean;
  nightQuiet: boolean;
  lang: Lang; // missing in beats from older bots → 'ru'
}

export type Text = (lang: Lang) => string;

const T = {
  offline: {
    ru: (at: string) =>
      `<b>⚠️ Дом не на связи с ${at}</b>\n<i>Бот на NAS не отвечает: нет интернета, выключен роутер или NAS. Уведомления о свете временно не приходят.</i>`,
    uk: (at: string) =>
      `<b>⚠️ Дім не на зв'язку з ${at}</b>\n<i>Бот на NAS не відповідає: немає інтернету, вимкнено роутер або NAS. Сповіщення про світло тимчасово не приходять.</i>`,
    en: (at: string) =>
      `<b>⚠️ Home offline since ${at}</b>\n<i>The bot on the NAS isn't responding: no internet, or the router or NAS is off. Power notifications are paused.</i>`,
  },
  online: {
    ru: (at: string, d: string) => `<b>✅ Дом снова на связи · ${at}</b>\n<i>не было связи ${d}</i>`,
    uk: (at: string, d: string) => `<b>✅ Дім знову на зв'язку · ${at}</b>\n<i>не було зв'язку ${d}</i>`,
    en: (at: string, d: string) => `<b>✅ Home back online · ${at}</b>\n<i>offline for ${d}</i>`,
  },
  units: { ru: ['ч', 'мин'], uk: ['год', 'хв'], en: ['h', 'min'] },
} as const;

/** Sent by the bot every few minutes. */
export interface Beat {
  ts: number;
  tz: string;
  quietFrom: number;
  quietTo: number;
  chats: Chat[]; // users who enabled the "home offline" alert
}

export interface State {
  downSince: number | null; // last beat before the silence
}

const MIN = 60_000;

function localHour(ts: number, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(ts)) % 24;
}

function hhmm(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
}

function duration(ms: number, lang: Lang): string {
  const [hu, mu] = T.units[lang];
  const m = Math.max(1, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h} ${hu} ${m % 60} ${mu}` : `${h} ${hu}`) : `${m} ${mu}`;
}

export function silentFor(c: Chat, b: Beat, nowMs: number): boolean {
  if (c.muted) return true;
  if (!c.nightQuiet) return false;
  const h = localHour(nowMs, b.tz);
  return b.quietFrom > b.quietTo ? h >= b.quietFrom || h < b.quietTo : h >= b.quietFrom && h < b.quietTo;
}

export function onCron(beat: Beat | null, s: State, nowMs: number, downAfterMs: number): { state: State; msg: Text | null } {
  if (!beat || s.downSince !== null || nowMs - beat.ts <= downAfterMs) return { state: s, msg: null };
  const at = hhmm(beat.ts, beat.tz);
  return { state: { downSince: beat.ts }, msg: (lang) => T.offline[lang](at) };
}

export function onBeat(s: State, nowMs: number, tz: string): { state: State; msg: Text | null } {
  if (s.downSince === null) return { state: s, msg: null };
  const at = hhmm(nowMs, tz);
  const down = nowMs - s.downSince;
  return { state: { downSince: null }, msg: (lang) => T.online[lang](at, duration(down, lang)) };
}

/** An unset secret must never authorize ("Bearer undefined"). */
export function authorized(header: string | null, secret: string | undefined): boolean {
  return !!secret && header === `Bearer ${secret}`;
}

// An unknown zone makes Intl throw in every cron run, and "home offline" would never go out.
function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** DOWN_AFTER_MIN env → ms; a missing or non-numeric value means 10 min. */
export function downAfterMs(v: string | undefined): number {
  const n = Number(v);
  return (v && Number.isFinite(n) && n > 0 ? n : 10) * MIN;
}

export function parseBeat(v: unknown): Beat | null {
  const b = v as Beat | null;
  if (!b || typeof b.tz !== 'string' || typeof b.quietFrom !== 'number' || typeof b.quietTo !== 'number' || !Array.isArray(b.chats)) return null;
  if (!validZone(b.tz)) return null;
  if (!b.chats.every((c) => c && typeof c.id === 'number' && typeof c.muted === 'boolean' && typeof c.nightQuiet === 'boolean')) return null;
  const lang = (v: unknown): Lang => (LANGS.includes(v as Lang) ? (v as Lang) : 'ru');
  return {
    ts: Number(b.ts) || 0,
    tz: b.tz,
    quietFrom: b.quietFrom,
    quietTo: b.quietTo,
    chats: b.chats.map((c) => ({ id: c.id, muted: c.muted, nightQuiet: c.nightQuiet, lang: lang(c.lang) })),
  };
}
