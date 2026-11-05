import { dicts } from '../src/i18n/index.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { applyOverrides, fieldText, FIELDS, parsePrice, validValue } from '../src/settings.js';

const base = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });

describe('settings', () => {
  it('defaults come from env: YASNO day/night', () => {
    expect([base.tariffDay, base.tariffNight, base.tariffNightFrom, base.tariffNightTo]).toEqual([4.32, 2.16, 23, 7]);
  });

  it('valid overrides win, invalid and unknown ones are ignored', () => {
    const c = applyOverrides(base, { batteryTempMaxC: 50, inverterTempMaxC: 999, tariffNight: null, batteryThresholds: [20, 50], telegramToken: 'x' } as never);
    expect(c.batteryTempMaxC).toBe(50);
    expect(c.inverterTempMaxC).toBe(base.inverterTempMaxC);
    expect(c.tariffNight).toBeNull();
    expect(c.batteryThresholds).toEqual([50, 20]); // kept sorted high → low
    expect(c.telegramToken).toBe('t');
  });

  it('grid-load threshold accepts only the offered values', () => {
    expect(validValue('gridLoadMaxKw', 6.5)).toBe(true);
    expect(validValue('gridLoadMaxKw', 8)).toBe(false);
  });

  it('parses typed prices with comma or dot', () => {
    expect(parsePrice('4,32')).toBe(4.32);
    expect(parsePrice(' 2.16 ₴ ')).toBe(2.16);
    expect(parsePrice('abc')).toBeNull();
    expect(parsePrice('0')).toBeNull();
  });

  it('formats values for the menu', () => {
    const f = (k: string) => FIELDS.find((x) => x.key === k)!;
    expect(fieldText(f('tariffNight'), null, dicts.ru)).toBe('однозонный');
    expect(fieldText(f('tariffNightFrom'), 23, dicts.ru)).toBe('23:00');
    expect(fieldText(f('batteryThresholds'), [50, 30], dicts.ru)).toBe('50 / 30%');
  });
});
