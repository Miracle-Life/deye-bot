// Per-user language: typed dictionaries, one per language.
import { en } from './en.js';
import { ru, type Dict } from './ru.js';
import { uk } from './uk.js';

export type { Dict };
export type Lang = 'uk' | 'ru' | 'en';
export const LANGS: Lang[] = ['uk', 'ru', 'en'];
export const dicts: Record<Lang, Dict> = { uk, ru, en };

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as string[]).includes(v);

/** Telegram `language_code` → bot language; anything else gets English. */
export function pickLang(code: string | undefined): Lang {
  const base = code?.toLowerCase().split('-')[0];
  return base === 'uk' || base === 'ru' ? base : 'en';
}
