import { describe, expect, it } from 'vitest';
import { dicts, isLang, LANGS, pickLang } from '../src/i18n/index.js';

function leafStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(leafStrings);
  return [];
}

describe('pickLang', () => {
  it('maps Telegram language codes', () => {
    expect(pickLang('uk')).toBe('uk');
    expect(pickLang('uk-UA')).toBe('uk');
    expect(pickLang('ru')).toBe('ru');
    expect(pickLang('en-GB')).toBe('en');
  });

  it('falls back to English for anything else', () => {
    expect(pickLang('de')).toBe('en');
    expect(pickLang(undefined)).toBe('en');
    expect(pickLang('')).toBe('en');
  });
});

describe('dictionaries', () => {
  it('have no empty strings', () => {
    for (const l of LANGS) expect(leafStrings(dicts[l]).filter((s) => !s.trim())).toEqual([]);
  });

  it('carry their own locale', () => {
    for (const l of LANGS) expect(dicts[l].locale).toBe(l);
  });

  it('isLang guards stored values', () => {
    expect(isLang('uk')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe('button labels fit on a phone', () => {
  // Telegram truncates: 3 buttons per row ≈ 9 chars each, 2 per row ≈ 15.
  const visible = (s: string) => [...s.replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|️/gu, '')].length;

  it('language buttons are a flag and a two-letter code', () => {
    expect(LANGS.map((l) => dicts[l].langShort)).toEqual(['🇺🇦 UA', '🇷🇺 RU', '🇬🇧 EN']);
  });

  it('settings section buttons fit two per row', () => {
    for (const l of LANGS) for (const t of Object.values(dicts[l].cfg.sections)) expect(visible(t), t).toBeLessThanOrEqual(15);
  });
});
