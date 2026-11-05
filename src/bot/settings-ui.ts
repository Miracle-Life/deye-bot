// Owner settings menu: text + inline keyboards built from the settings registry.
import { InlineKeyboard } from 'grammy';
import { FIELDS, fieldText, fieldTexts, SECTIONS, unitText, type Field, type SettingsStore } from '../settings.js';
import type { Dict } from '../i18n/index.js';

export interface View {
  text: string;
  kb: InlineKeyboard;
}

// grammY keeps empty rows, which Telegram rejects.
const newRow = (kb: InlineKeyboard) => (kb.inline_keyboard.at(-1)?.length ? kb.row() : kb);
const fieldsOf = (section: string) => FIELDS.filter((f) => f.section === section);
const val = (s: SettingsStore, f: Field, t: Dict) => fieldText(f, s.get(f.key), t);

/** `address`: the owner's schedule address line (from the schedule service). */
export function homeView(s: SettingsStore, t: Dict, address: string): View {
  const lines = [t.cfg.title, t.cfg.subtitle, '', address, ''];
  for (const sec of SECTIONS) {
    lines.push(`<b>${t.cfg.sections[sec]}</b>`);
    for (const f of fieldsOf(sec)) lines.push(`   ${fieldTexts(f, t).label}: <b>${val(s, f, t)}</b>`);
  }
  const kb = new InlineKeyboard();
  SECTIONS.forEach((sec, i) => {
    kb.text(t.cfg.sections[sec], `cfg:s:${sec}`);
    if (i % 2 === 1) newRow(kb);
  });
  newRow(kb).text(t.addr.button, 'adr:start').row().text(t.cfg.back, 'set:home');
  return { text: lines.join('\n'), kb };
}

export function sectionView(s: SettingsStore, id: string, t: Dict): View | null {
  const sec = SECTIONS.find((x) => x === id);
  if (!sec) return null;
  const kb = new InlineKeyboard();
  for (const f of fieldsOf(sec)) kb.text(`${fieldTexts(f, t).label}: ${val(s, f, t)}`, `cfg:f:${f.key}`).row();
  kb.text(t.cfg.allSettings, 'cfg:home');
  return { text: `<b>${t.cfg.sections[sec]}</b>\n${t.cfg.pick}`, kb };
}

export function fieldView(s: SettingsStore, f: Field, t: Dict, note?: string): View {
  const cur = s.get(f.key);
  const def = s.defaultOf(f.key);
  const ft = fieldTexts(f, t);
  const lines = [`<b>${t.cfg.sections[f.section]} → ${ft.label}</b>`, `${t.cfg.current} <b>${fieldText(f, cur, t)}</b>`];
  if (JSON.stringify(cur) !== JSON.stringify(def)) lines.push(`<i>${t.cfg.byDefault(fieldText(f, def, t))}</i>`);
  if (ft.hint) lines.push(`<i>${ft.hint}</i>`);
  if (note) lines.push('', note);

  const kb = new InlineKeyboard();
  const opts = f.options ?? [];
  if (f.kind === 'multi') {
    const set = new Set(cur as number[]);
    opts.forEach((o, i) => {
      kb.text(`${set.has(o) ? '✅' : '▫️'} ${o}${unitText(f, t)}`, `cfg:t:${f.key}:${o}`);
      if (i % 5 === 4) newRow(kb);
    });
    newRow(kb);
  } else if (f.kind === 'choice') {
    opts.forEach((o, i) => {
      kb.text(`${cur === o ? '● ' : ''}${fieldText(f, o, t)}`, `cfg:v:${f.key}:${o}`);
      if (i % 3 === 2) newRow(kb);
    });
    newRow(kb);
  } else {
    for (const o of opts) kb.text(`${cur === o ? '● ' : ''}${o.toFixed(2)} ₴`, `cfg:v:${f.key}:${o}`);
    if (ft.nullLabel) kb.text(`${cur === null ? '● ' : ''}${ft.nullLabel}`, `cfg:v:${f.key}:null`);
    newRow(kb).text(t.cfg.customPrice, `cfg:i:${f.key}`).row();
  }
  if (JSON.stringify(cur) !== JSON.stringify(def)) kb.text(t.cfg.reset, `cfg:r:${f.key}`);
  kb.text(t.cfg.back, `cfg:s:${f.section}`);
  return { text: lines.join('\n'), kb };
}
