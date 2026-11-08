import { DateTime } from 'luxon';
import { InlineKeyboard } from 'grammy';
import type { UserRow } from '../storage/repo.js';
import { dicts, LANGS, type Dict, type Lang } from '../i18n/index.js';

// Callback data never depends on the language, so buttons on old messages keep working.

export function panelKb(t: Dict, schedule = false): InlineKeyboard {
  const kb = new InlineKeyboard().text(t.kb.stats, 's:d:today').text(t.kb.money, 'e:now').row();
  if (schedule) kb.text(t.kb.schedule, 'sch:show');
  return kb.text(t.kb.refresh, 'r:panel');
}

/** Every screen but the panel ends with a full-width "🏠 Home" row that opens the /start panel. */
export function withHome(kb: InlineKeyboard, t: Dict): InlineKeyboard {
  const last = kb.inline_keyboard.at(-1);
  if (!last || last.length) kb.row(); // InlineKeyboard.from([]) has no row at all
  return kb.text(t.kb.home, 'v:panel');
}

export const homeKb = (t: Dict) => withHome(new InlineKeyboard(), t);

const archiveRow = (kb: InlineKeyboard, t: Dict) => kb.text(t.kb.archWeek, 'sa:w:now').text(t.kb.archMonth, 'sa:m:now').text(t.kb.archQuarter, 'sa:q:now');

const MAX_PICKS = 10;

/** YASNO search results as buttons, 10 per page with ‹ › (adr:pg:<page>); says where you are in the list. */
export function addressPicks(
  opts: { id: number; name: string }[],
  kind: 'street' | 'house',
  t: Dict,
  page = 0,
): { text: string; kb: InlineKeyboard; names: Map<string, string> } {
  const pages = Math.max(1, Math.ceil(opts.length / MAX_PICKS));
  const p = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const shown = opts.slice(p * MAX_PICKS, (p + 1) * MAX_PICKS);
  const kb = new InlineKeyboard();
  const names = new Map<string, string>();
  for (const o of shown) {
    const data = kind === 'street' ? `adr:st:${o.id}` : `adr:h:${o.id}`;
    names.set(data, o.name);
    kb.text(o.name, data).row();
  }
  if (p > 0) kb.text(t.kb.pagePrev, `adr:pg:${p - 1}`);
  if (p < pages - 1) kb.text(t.kb.pageNext, `adr:pg:${p + 1}`);
  const head = kind === 'street' ? t.addr.pickStreet : t.addr.pickHouse;
  if (pages === 1) return { text: head, kb, names };
  const range = [p * MAX_PICKS + 1, p * MAX_PICKS + shown.length, opts.length] as const;
  return { text: `${head}\n${kind === 'street' ? t.addr.moreStreets(...range) : t.addr.moreHouses(...range)}`, kb, names };
}

export function scheduleKb(t: Dict): InlineKeyboard {
  return withHome(archiveRow(new InlineKeyboard().text(t.kb.refresh, 'sch:refresh').row(), t), t);
}

/** Past schedules: ‹ › by period, then the periods, then home. */
export function archiveKb(kind: 'w' | 'm' | 'q', nav: PeriodNav, t: Dict): InlineKeyboard {
  const [prev, next] = kind === 'w' ? [t.kb.prevWeek, t.kb.nextWeek] : kind === 'm' ? [t.kb.prevMonth, t.kb.nextMonth] : [t.kb.earlier, t.kb.later];
  return withHome(archiveRow(navRow(new InlineKeyboard(), nav, prev, next), t), t);
}

export function moneyKb(nav: PeriodNav, t: Dict): InlineKeyboard {
  const kb = navRow(new InlineKeyboard(), nav, t.kb.prevMonth, t.kb.nextMonth);
  return withHome(kb.text(t.kb.stats, 's:d:today'), t);
}

export interface PeriodNav {
  prev: string | null; // callback data, null when out of range
  next: string | null;
}

function navRow(kb: InlineKeyboard, nav: PeriodNav, prevLabel: string, nextLabel: string): InlineKeyboard {
  if (nav.prev) kb.text(prevLabel, nav.prev);
  if (nav.next) kb.text(nextLabel, nav.next);
  return nav.prev || nav.next ? kb.row() : kb;
}

export function dayKb(dateIso: string, nav: PeriodNav, zone: string, t: Dict): InlineKeyboard {
  const d = DateTime.fromISO(dateIso, { zone }).setLocale(t.locale);
  const kb = navRow(new InlineKeyboard(), nav, `‹ ${d.minus({ days: 1 }).toFormat('d MMM')}`, `${d.plus({ days: 1 }).toFormat('d MMM')} ›`);
  return withHome(kb.text(t.kb.week, `s:w:${dateIso}`).text(t.kb.month, `s:m:${dateIso.slice(0, 7)}`), t);
}

export function periodKb(kind: 'w' | 'm', anchorIso: string, nav: PeriodNav, t: Dict): InlineKeyboard {
  const day = kind === 'w' ? anchorIso : `${anchorIso}-01`;
  const kb = navRow(new InlineKeyboard(), nav, kind === 'w' ? t.kb.prevWeek : t.kb.prevMonth, kind === 'w' ? t.kb.nextWeek : t.kb.nextMonth);
  kb.text(t.kb.day, `s:d:${day}`);
  if (kind === 'w') kb.text(t.kb.month, `s:m:${anchorIso.slice(0, 7)}`);
  else kb.text(t.kb.week, `s:w:${day}`);
  return withHome(kb, t);
}

export function accessKb(tgId: number, t: Dict): InlineKeyboard {
  return new InlineKeyboard().text(t.kb.allow, `u:ok:${tgId}`).text(t.kb.reject, `u:no:${tgId}`);
}

export function usersKb(users: UserRow[], adminId: number, t: Dict): InlineKeyboard {
  // One button per row, no trailing empty row.
  return withHome(InlineKeyboard.from(users.filter((u) => u.tgId !== adminId).map((u) => [InlineKeyboard.text(t.kb.remove(u.name), `u:del:${u.tgId}`)])), t);
}

const REMINDER_LEADS = [0, 15, 30, 60];

/** Tapping a reminder button cycles off → 15 → 30 → 60 → off. */
export function nextReminderLead(min: number): number {
  return REMINDER_LEADS[(REMINDER_LEADS.indexOf(min) + 1) % REMINDER_LEADS.length] ?? 30;
}

export function settingsKb(
  muted: boolean,
  nightQuiet: boolean,
  admin: boolean,
  watchdog: boolean | null,
  lang: Lang,
  t: Dict,
  reminders: { off: number; on: number } | null = null, // null: no schedule address, hide
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const l of LANGS) kb.text(`${l === lang ? '✅ ' : ''}${dicts[l].langShort}`, `set:lang:${l}`);
  kb.row()
    .text(muted ? t.kb.soundOn : t.kb.soundOff, 'set:mute')
    .row()
    .text(nightQuiet ? t.kb.nightOff : t.kb.nightOn, 'set:night');
  if (watchdog !== null) kb.row().text(watchdog ? t.kb.watchOff : t.kb.watchOn, 'set:watch');
  if (reminders) kb.row().text(t.kb.remindOff(reminders.off), 'set:rem:off').row().text(t.kb.remindOn(reminders.on), 'set:rem:on');
  // The owner can't leave: the bot would be left without an admin.
  return withHome(admin ? kb.row().text(t.kb.botSettings, 'cfg:home') : kb.row().text(t.kb.leave, 'set:leave'), t);
}

export function leaveKb(t: Dict): InlineKeyboard {
  return new InlineKeyboard().text(t.kb.leaveYes, 'set:leave:yes').text(t.kb.stay, 'set:home');
}

export function restartKb(t: Dict): InlineKeyboard {
  return new InlineKeyboard().text(t.kb.restartYes, 'sys:restart').text(t.kb.cancel, 'sys:cancel');
}
