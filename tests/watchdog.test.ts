import { describe, expect, it } from 'vitest';
import { authorized, downAfterMs, onBeat, onCron, parseBeat, silentFor, type Beat } from '../worker/src/logic.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 8, 20); // 10:20 Kyiv
const beat = (ts: number): Beat => ({ ts, tz: 'Europe/Kyiv', quietFrom: 23, quietTo: 7, chats: [{ id: 1, muted: false, nightQuiet: true, lang: 'ru' }] });

describe('watchdog worker', () => {
  it('stays quiet while beats are fresh', () => {
    expect(onCron(beat(T0), { downSince: null }, T0 + 9 * MIN, 10 * MIN).msg).toBeNull();
  });

  it('reports "home offline" once when beats stop', () => {
    const r = onCron(beat(T0), { downSince: null }, T0 + 11 * MIN, 10 * MIN);
    expect(r.state).toEqual({ downSince: T0 });
    expect(r.msg!('ru')).toContain('Дом не на связи с 10:20');
    expect(r.msg!('en')).toContain('Home offline since 10:20');
    expect(r.msg!('uk')).toContain('Дім не на зв');
    expect(onCron(beat(T0), r.state, T0 + 16 * MIN, 10 * MIN).msg).toBeNull();
  });

  it('reports recovery with the offline duration on the next beat', () => {
    const r = onBeat({ downSince: T0 }, T0 + 35 * MIN, 'Europe/Kyiv');
    expect(r.state).toEqual({ downSince: null });
    expect(r.msg!('ru')).toContain('Дом снова на связи');
    expect(r.msg!('ru')).toContain('35 мин');
    expect(r.msg!('uk')).toContain('35 хв');
    expect(r.msg!('en')).toContain('35 min');
    expect(onBeat({ downSince: null }, T0, 'Europe/Kyiv').msg).toBeNull();
  });

  it('respects mute and night mode', () => {
    const b = beat(T0);
    expect(silentFor({ id: 1, muted: false, nightQuiet: true }, b, T0)).toBe(false);
    expect(silentFor({ id: 1, muted: false, nightQuiet: true }, b, Date.UTC(2026, 10, 4, 22, 0))).toBe(true); // 00:00 Kyiv
    expect(silentFor({ id: 1, muted: true, nightQuiet: false }, b, T0)).toBe(true);
  });
});

describe('watchdog worker input', () => {
  it('rejects check-ins when the secret is missing or wrong', () => {
    expect(authorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(authorized('Bearer undefined', undefined)).toBe(false);
    expect(authorized('Bearer ', '')).toBe(false);
    expect(authorized(null, 's3cret')).toBe(false);
  });

  it('accepts only a well-formed beat', () => {
    const ok = { ts: 1, tz: 'Europe/Kyiv', quietFrom: 23, quietTo: 7, chats: [{ id: 5, muted: false, nightQuiet: true, lang: 'en' }] };
    expect(parseBeat(ok)).toEqual(ok);
    expect(parseBeat({ ...ok, chats: [{ id: 'x' }] })).toBeNull();
    expect(parseBeat({ ...ok, tz: 42 })).toBeNull();
    expect(parseBeat({ ...ok, tz: 'Mars/Olympus' })).toBeNull(); // would throw in every cron run
    expect(downAfterMs(undefined)).toBe(10 * 60_000);
    expect(downAfterMs('abc')).toBe(10 * 60_000);
    expect(downAfterMs('15')).toBe(15 * 60_000);
    expect(parseBeat(null)).toBeNull();
  });

  it('treats a missing or unknown language as Russian (old bot / new worker)', () => {
    const base = { ts: 1, tz: 'Europe/Kyiv', quietFrom: 23, quietTo: 7 };
    expect(parseBeat({ ...base, chats: [{ id: 1, muted: false, nightQuiet: false }] })!.chats[0]!.lang).toBe('ru');
    expect(parseBeat({ ...base, chats: [{ id: 1, muted: false, nightQuiet: false, lang: 'de' }] })!.chats[0]!.lang).toBe('ru');
    expect(parseBeat({ ...base, chats: [{ id: 1, muted: false, nightQuiet: false, lang: 'uk' }] })!.chats[0]!.lang).toBe('uk');
  });
});
