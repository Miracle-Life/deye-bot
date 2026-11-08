import { describe, expect, it } from 'vitest';
import { addressPicks, archiveKb, dayKb, homeKb, moneyKb, periodKb, scheduleKb, settingsKb, usersKb } from '../src/bot/keyboards.js';
import { dicts } from '../src/i18n/index.js';
import { archiveNav, resolveArchiveAnchor } from '../src/schedule/archive.js';
import { loadConfig } from '../src/config.js';
import { fieldView, sectionView } from '../src/bot/settings-ui.js';
import { FIELDS, SettingsStore } from '../src/settings.js';

const uk = dicts.uk;
const Z = 'Europe/Kyiv';
const data = (kb: { inline_keyboard: { callback_data?: string }[][] }) => kb.inline_keyboard.map((row) => row.map((b) => b.callback_data));

describe('schedule keyboards', () => {
  it('schedule card: refresh, the archive periods, then home on its own row', () => {
    expect(data(scheduleKb(uk))).toEqual([['sch:refresh'], ['sa:w:now', 'sa:m:now', 'sa:q:now'], ['v:panel']]);
  });

  it('archive card: optional ‹ › row, periods (3 per row), home row', () => {
    const kb = archiveKb('w', { prev: 'sa:w:2026-10-26', next: null }, uk);
    expect(data(kb)).toEqual([['sa:w:2026-10-26'], ['sa:w:now', 'sa:m:now', 'sa:q:now'], ['v:panel']]);
    expect(kb.inline_keyboard[1]!.map((b) => b.text)).toEqual(['Тиждень', 'Місяць', '3 місяці']);
    expect(kb.inline_keyboard[2]![0]!.text).toBe('🏠 На головну');
    expect(data(archiveKb('m', { prev: null, next: null }, uk))).toHaveLength(2);
  });
});

describe('every screen but the panel has a labelled home row', () => {
  const lastRow = (kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) => kb.inline_keyboard.at(-1)!;
  it.each([
    ['day', dayKb('2026-11-08', { prev: null, next: null }, Z, uk)],
    ['week', periodKb('w', '2026-11-02', { prev: null, next: null }, uk)],
    ['money', moneyKb({ prev: null, next: null }, uk)],
    ['settings', settingsKb(false, false, true, null, 'uk', uk)],
    ['users', usersKb([], 1, uk)],
    ['home only', homeKb(uk)],
  ])('%s', (_, kb) => {
    expect(lastRow(kb)).toEqual([expect.objectContaining({ text: '🏠 На головну', callback_data: 'v:panel' })]);
  });
});

describe('settings sections and fields end with home too', () => {
  const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
  const st = new SettingsStore(cfg, { ...cfg }, () => null, () => {});
  it.each([
    ['section', sectionView(st, 'load', uk)!.kb],
    ['field', fieldView(st, FIELDS.find((f) => f.key === 'gridChargeA')!, uk).kb],
  ])('%s', (_, kb) => {
    expect(kb.inline_keyboard.at(-1)).toEqual([expect.objectContaining({ text: '🏠 На головну', callback_data: 'v:panel' })]);
  });
});

describe('address picks', () => {
  const opts = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: `4, БУД ${i + 1}` }));
  it('10 per page with ‹ › to page through, and how many there are', () => {
    const p = addressPicks(opts, 'house', uk);
    expect(p.kb.inline_keyboard).toHaveLength(11); // 10 houses + nav row
    expect(p.kb.inline_keyboard.at(-1)!.map((b) => [b.text, (b as { callback_data?: string }).callback_data])).toEqual([['Далі ›', 'adr:pg:1']]);
    expect(p.text).toBe('Обери будинок:\n1–10 з 14 — гортай або уточни номер, наприклад «12/к2»');
    expect(p.names.get('adr:h:3')).toBe('4, БУД 3');
    const p2 = addressPicks(opts, 'house', uk, 1);
    expect(p2.kb.inline_keyboard).toHaveLength(5); // 4 houses + nav row
    expect(p2.kb.inline_keyboard.at(-1)!.map((b) => (b as { callback_data?: string }).callback_data)).toEqual(['adr:pg:0']);
    expect(p2.text).toContain('11–14 з 14');
    expect(addressPicks(opts, 'house', uk, 9).text).toContain('11–14 з 14'); // out of range → last page
  });

  it('no note when everything fits', () => {
    expect(addressPicks(opts.slice(0, 3), 'street', uk).text).toBe('Обери вулицю:');
  });
});

describe('archive anchors', () => {
  it('clamps out-of-range anchors', () => {
    expect(resolveArchiveAnchor('w', '2025-01-06', '2026-11-08', '2026-11-08', Z)).toBe('2026-11-02');
    expect(resolveArchiveAnchor('m', '2027-01', '2026-09-14', '2026-11-08', Z)).toBe('2026-11');
    expect(resolveArchiveAnchor('w', 'now', null, '2026-11-08', Z)).toBe('2026-11-02');
    expect(resolveArchiveAnchor('m', 'garbage', '2026-09-14', '2026-11-08', Z)).toBe('2026-11');
    expect(resolveArchiveAnchor('q', '2026-10-15', '2026-09-14', '2026-11-08', Z)).toBe('2026-10-12');
  });

  it('nav: no ‹ before the oldest day, no › for the current period', () => {
    expect(archiveNav('w', '2026-11-02', '2026-10-28', '2026-11-08', Z)).toEqual({ prev: 'sa:w:2026-10-26', next: null });
    expect(archiveNav('w', '2026-10-26', '2026-10-28', '2026-11-08', Z)).toEqual({ prev: null, next: 'sa:w:2026-11-02' });
    expect(archiveNav('m', '2026-10', '2026-09-14', '2026-11-08', Z)).toEqual({ prev: 'sa:m:2026-09', next: 'sa:m:2026-11' });
    expect(archiveNav('q', '2026-11-02', '2026-09-14', '2026-11-08', Z)).toEqual({ prev: null, next: null });
  });
});
