import { DateTime } from 'luxon';
import { dicts } from '../src/i18n/index.js';
import { describe, expect, it } from 'vitest';
import { renderCloud, renderStatus, renderWatch } from '../src/bot/ops-format.js';

const Z = 'Europe/Kyiv';
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();

describe('renderWatch', () => {
  it('night shortfall tells when it ends and what load would last', () => {
    const m = renderWatch({ type: 'night_short', soc: 34, loadW: 1400, endsAt: at('2026-11-05T03:02'), needW: 707, morningTs: at('2026-11-05T07:00') }, Z, dicts.ru);
    expect(m.silent).toBe(false);
    expect(m.text).toContain('До утра может не хватить');
    expect(m.text).toContain('хватит до ≈ 03:02');
    expect(m.text).toContain('не больше 710 Вт');
  });

  it('new inverter alert is loud and shows code and name', () => {
    const m = renderWatch({ type: 'alert_new', alert: { id: '1', code: 'F13', name: 'Grid <lost>', level: null, startTs: at('2026-11-04T09:12'), endTs: null } }, Z, dicts.ru);
    expect(m.silent).toBe(false);
    expect(m.text).toContain('F13 · Grid &lt;lost&gt;');
    expect(m.text).toContain('с 09:12');
  });

  it('cooling down is silent', () => {
    expect(renderWatch({ type: 'temp_ok', which: 'inverter', tempC: 60, limitC: 70 }, Z, dicts.ru).silent).toBe(true);
  });
});

describe('renderWatch: may not last until the scheduled power-on', () => {
  it('names the schedule time and the advised load', () => {
    const e = { type: 'night_short' as const, target: 'schedule' as const, soc: 30, loadW: 1200, endsAt: at('2026-11-05T00:20'), needW: 440, morningTs: at('2026-11-05T06:00') };
    expect(renderWatch(e, Z, dicts.ru).text).toContain('свет по графику в 06:00');
    expect(renderWatch(e, Z, dicts.ru).text).toContain('снизьте потребление до ~440 Вт');
    expect(renderWatch(e, Z, dicts.uk).text).toContain('світло за графіком о 06:00');
    expect(renderWatch(e, Z, dicts.en).text).toContain('power back by schedule at 06:00');
  });
});

describe('renderWatch: night warning at the reserve', () => {
  it('says the reserve is reached instead of "no more than 0 W"', () => {
    const m = renderWatch({ type: 'night_short', soc: 10, loadW: 800, endsAt: at('2026-11-04T21:00'), needW: 0, morningTs: at('2026-11-05T07:00') }, Z, dicts.ru);
    expect(m.text).not.toContain('не больше');
    expect(m.text).toContain('заряд уже на уровне резерва');
  });
});

describe('renderWatch: grid load', () => {
  it('loud alert with the split and the breaker', () => {
    const m = renderWatch({ type: 'grid_high', load: { totalW: 7300, homeW: 3100, batteryW: 4200 }, limitW: 7000 }, Z, dicts.ru);
    expect(m.silent).toBe(false);
    expect(m.text).toContain('Из сети 7.3 кВт');
    expect(m.text).toContain('дом 3.1 + батареи 4.2');
    expect(m.text).toContain('автомат ~8 кВт');
  });

  it('quiet all-clear', () => {
    const m = renderWatch({ type: 'grid_ok', totalW: 6200 }, Z, dicts.ru);
    expect(m.silent).toBe(true);
    expect(m.text).toContain('Нагрузка в норме · 6.2 кВт');
  });
});

describe('renderWatch: alert without code or name', () => {
  const a = { id: '1', code: null, name: '', level: null, startTs: null, endTs: null };
  it('has no empty quote or dangling separator', () => {
    expect(renderWatch({ type: 'alert_new', alert: a }, Z, dicts.ru).text).toBe('<b>🚨 Авария инвертора</b>');
    expect(renderWatch({ type: 'alert_end', alert: a }, Z, dicts.ru).text).toBe('<b>✅ Авария закончилась</b>');
  });
});

describe('renderCloud', () => {
  it('auth problems are loud, outages of the cloud are quiet', () => {
    expect(renderCloud({ type: 'cloud_auth', error: 'wrong password' }, Z, dicts.ru).silent).toBe(false);
    expect(renderCloud({ type: 'cloud_down', sinceTs: at('2026-11-04T09:20'), error: 'HTTP 502' }, Z, dicts.ru)).toMatchObject({ silent: true });
  });
});

describe('renderStatus', () => {
  it('lists the key health lines', () => {
    const now = at('2026-11-04T12:00');
    const t = renderStatus(
      {
        nowMs: now,
        startedAt: at('2026-11-04T09:00'),
        lastOkAt: now - 20_000,
        lastFrameTs: now - 70_000,
        lagMs: 47_000,
        periodMs: 180_000,
        nextPollAt: now + 130_000,
        errors24h: 2,
        lastError: { at: at('2026-11-04T07:31'), msg: 'HTTP 502' },
        cloudFailingSince: null,
        alertsActive: 0,
        alertsCheckedAt: now - 60_000,
        batteryTempC: 27,
        inverterTempC: 42,
        dbBytes: 1_300_000,
        readings: 1840,
        outages: 3,
        users: 2,
        rssMb: 92.4,
      },
      Z,
      dicts.ru,
    );
    expect(t).toContain('Работает 3 ч');
    expect(t).toContain('задержка облака ≈ 47 с');
    expect(t).toContain('Ошибок за сутки: 2');
    expect(t).toContain('1.3 МБ');
    expect(t).toContain('память 92 МБ');
  });
});
