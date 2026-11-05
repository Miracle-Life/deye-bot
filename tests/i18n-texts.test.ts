import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtPower, renderEvent } from '../src/bot/format.js';
import { renderWatch } from '../src/bot/ops-format.js';
import { loadConfig } from '../src/config.js';
import { emptyReading } from '../src/deye/types.js';
import { dicts } from '../src/i18n/index.js';
import { fieldText, FIELDS } from '../src/settings.js';
import { leaveKb, nextReminderLead, settingsKb } from '../src/bot/keyboards.js';

const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Kyiv' }).toMillis();
const H = 3_600_000;

describe('texts in other languages', () => {
  it('durations use the language units', () => {
    expect(fmtDuration(8 * H + 12 * 60_000, dicts.en)).toBe('8 h 12 min');
    expect(fmtDuration(26 * H, dicts.uk)).toBe('1 доб 2 год');
  });

  it('power uses the language units', () => {
    expect(fmtPower(4100, dicts.en)).toBe('4.1 kW');
  });

  it('outage notification in English', () => {
    const ts = at('2026-11-04T04:17');
    const r = { ...emptyReading(ts), soc: 72, batteryPowerW: -274, upsLoadPowerW: 211 };
    const m = renderEvent({ type: 'outage_started', ts, approxFromTs: null, missingPhases: ['L1', 'L2', 'L3'], reading: r }, cfg, dicts.en);
    expect(m.text).toContain('Power outage · 04:17');
  });

  it('grid-load alert in Ukrainian', () => {
    const m = renderWatch({ type: 'grid_high', load: { totalW: 7300, homeW: 3100, batteryW: 4200 }, limitW: 7000 }, 'Europe/Kyiv', dicts.uk);
    expect(m.text).toContain('З мережі 7.3 кВт');
  });

  it('settings values in English', () => {
    const f = FIELDS.find((x) => x.key === 'gridLoadMaxKw')!;
    expect(fieldText(f, 7, dicts.en)).toBe('7 kW');
  });
});

describe('plurals', () => {
  it('counts repeats with the right word form', () => {
    expect([1, 2, 5, 12, 22].map((n) => dicts.ru.ops.repeated(n))).toEqual([
      '🐞 Повторилось ещё 1 раз за час',
      '🐞 Повторилось ещё 2 раза за час',
      '🐞 Повторилось ещё 5 раз за час',
      '🐞 Повторилось ещё 12 раз за час',
      '🐞 Повторилось ещё 22 раза за час',
    ]);
    expect([1, 3, 7].map((n) => dicts.uk.ops.repeated(n))).toEqual([
      '🐞 Повторилося ще 1 раз за годину',
      '🐞 Повторилося ще 3 рази за годину',
      '🐞 Повторилося ще 7 разів за годину',
    ]);
  });
});

describe('schedule reminders', () => {
  it('texts in three languages', () => {
    expect(dicts.uk.schedule.remindOff('22:00', 30)).toBe('⚡ Відключення за графіком о 22:00 (через 30 хв)');
    expect(dicts.ru.schedule.remindOn('06:00', 30)).toBe('💡 Свет по графику в 06:00 (через 30 мин)');
    expect(dicts.en.schedule.remindOff('22:00', 15)).toBe('⚡ Scheduled outage at 22:00 (in 15 min)');
  });

  it('settings buttons show the lead time and cycle off → 15 → 30 → 60 → off', () => {
    expect(dicts.uk.kb.remindOff(30)).toBe('⚡ Перед відключенням: 30 хв');
    expect(dicts.uk.kb.remindOn(0)).toBe('💡 Перед увімкненням: вимк');
    expect([0, 15, 30, 60].map(nextReminderLead)).toEqual([15, 30, 60, 0]);
  });
});

describe('leaving the bot', () => {
  const data = (kb: { inline_keyboard: { callback_data?: string }[][] }) => kb.inline_keyboard.flat().map((b) => b.callback_data);
  it('everyone but the owner gets a leave button with a confirmation', () => {
    expect(data(settingsKb(false, false, false, null, 'uk', dicts.uk))).toContain('set:leave');
    expect(data(settingsKb(false, false, true, null, 'uk', dicts.uk))).not.toContain('set:leave');
    expect(data(leaveKb(dicts.uk))).toEqual(['set:leave:yes', 'set:home']);
  });

  it('texts for the user and the owner', () => {
    expect(dicts.uk.kb.leave).toBe('🚪 Вийти з бота');
    expect(dicts.uk.bot.leftOwner('Оля', 'olya')).toBe('👋 Вихід із бота: <b>Оля</b> (@olya)');
    expect(dicts.ru.bot.blockedOwner('Оля', null)).toBe('🚫 Бот заблокирован: <b>Оля</b>');
  });
});
