import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { sha256Hex } from '../src/deye/official.js';

const minimal = {
  TELEGRAM_TOKEN: 't',
  ADMIN_TELEGRAM_ID: '123',
  DEYE_APP_ID: 'a',
  DEYE_APP_SECRET: 's',
  DEYE_EMAIL: 'e@x',
  DEYE_PASSWORD: 'p',
};

describe('loadConfig', () => {
  it('throws listing missing keys', () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_TOKEN[\s\S]*ADMIN_TELEGRAM_ID|ADMIN_TELEGRAM_ID[\s\S]*TELEGRAM_TOKEN/);
  });

  it('applies spec defaults', () => {
    const c = loadConfig(minimal);
    expect(c.pollIntervalSec).toBe(60);
    expect(c.staleAfterMin).toBe(15);
    expect(c.batteryReservePct).toBe(10);
    expect(c.batteryCapacityKwh).toBe(24);
    expect(c.batteryThresholds).toEqual([50, 30, 20, 10]);
    expect(c.gridOffVolts).toBe(50);
    expect(c.gridOkVolts).toBe(180);
    expect(c.timezone).toBe('Europe/Kyiv');
    expect(c.deyeSource).toBe('official');
    expect(c.adminTelegramId).toBe(123);
  });

  it('load limits: grid 8 kW, batteries 7 kW, grid charge 80 A by default', () => {
    const c = loadConfig(minimal);
    expect(c.gridLoadMaxKw).toBe(8);
    expect(c.batteryLoadMaxKw).toBe(7);
    expect(c.gridChargeA).toBe(80);
    expect(() => loadConfig({ ...minimal, GRID_CHARGE_A: '5' })).toThrow(/GRID_CHARGE_A/);
    expect(() => loadConfig({ ...minimal, BATTERY_LOAD_MAX_KW: '0' })).toThrow(/BATTERY_LOAD_MAX_KW/);
  });

  it('reads the grid-load threshold', () => {
    expect(loadConfig({ ...minimal, GRID_LOAD_MAX_KW: '6.5' }).gridLoadMaxKw).toBe(6.5);
  });

  it('rejects values that would break the bot at runtime', () => {
    expect(() => loadConfig({ ...minimal, TZ_NAME: 'Europe/Kiev-ish' })).toThrow(/TZ_NAME/);
    expect(() => loadConfig({ ...minimal, POLL_INTERVAL_SEC: '0' })).toThrow(/POLL_INTERVAL_SEC/);
    expect(() => loadConfig({ ...minimal, POLL_INTERVAL_SEC: '900' })).toThrow(/POLL_INTERVAL_SEC/); // watchdog would think the bot stalled
    expect(() => loadConfig({ ...minimal, WATCHDOG_URL: 'http://w.example' })).toThrow(/WATCHDOG_URL/);
    expect(loadConfig({ ...minimal, WATCHDOG_URL: 'https://w.example' }).watchdogUrl).toBe('https://w.example');
  });

  it('rated battery cycles: 6000 by default, sane range only', () => {
    expect(loadConfig(minimal).batteryRatedCycles).toBe(6000);
    expect(loadConfig({ ...minimal, BATTERY_RATED_CYCLES: '4000' }).batteryRatedCycles).toBe(4000);
    expect(() => loadConfig({ ...minimal, BATTERY_RATED_CYCLES: '50' })).toThrow(/BATTERY_RATED_CYCLES/);
  });

  it('sha256Hex matches known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
