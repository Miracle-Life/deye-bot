import { DateTime } from 'luxon';
import { dicts } from '../src/i18n/index.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { emptyReading } from '../src/deye/types.js';
import { eventMsg, fmtApprox, fmtApproxParts, fmtDuration, fmtKw, fmtKwMax, fmtPower, renderAccessRequest, renderDay, renderEvent, renderPanel, renderWeek, socBar } from '../src/bot/format.js';

const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Kyiv' }).toMillis();
const MIN = 60_000;
const ru = dicts.ru;
const reading = (ts: number, soc: number, battW: number, load: number, volts = [0, 0, 0]) => ({
  ...emptyReading(ts),
  soc,
  batteryPowerW: battW,
  upsLoadPowerW: load,
  gridVoltages: volts,
});

describe('format helpers', () => {
  it('socBar', () => {
    expect(socBar(72)).toBe('🟩🟩🟩🟩🟩🟩🟩⬜⬜⬜');
    expect(socBar(30)).toBe('🟨🟨🟨⬜⬜⬜⬜⬜⬜⬜');
    expect(socBar(10)).toBe('🟥⬜⬜⬜⬜⬜⬜⬜⬜⬜');
    expect(socBar(0)).toBe('⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜');
    expect(socBar(100)).toBe('🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩');
  });
  it('fmtDuration', () => {
    expect(fmtDuration(198 * MIN, ru)).toBe('3 ч 18 мин');
    expect(fmtDuration(52 * MIN, ru)).toBe('52 мин');
    expect(fmtDuration(120 * MIN, ru)).toBe('2 ч');
    expect(fmtDuration((51 * 60 + 5) * MIN, ru)).toBe('2 сут 3 ч');
  });

  it('fmtApprox: hours and minutes below 30 h, days from 30 h, "> 7 days" beyond a week', () => {
    const uk = dicts.uk;
    expect(fmtApprox(9.5 * 60 * MIN, uk)).toBe('9 год 30 хв');
    expect(fmtApprox(14.9 * 60 * MIN, uk)).toBe('14 год 54 хв');
    expect(fmtApprox(23.9 * 60 * MIN, uk)).toBe('23 год 54 хв');
    expect(fmtApprox(24 * 60 * MIN, uk)).toBe('24 год');
    expect(fmtApprox(29.9 * 60 * MIN, uk)).toBe('29 год 54 хв');
    expect(fmtApprox(30 * 60 * MIN, uk)).toBe('1 доб 6 год (30 год)');
    expect(fmtApprox(44.2 * 60 * MIN, uk)).toBe('1 доб 20 год (44 год)');
    expect(fmtApprox(48 * 60 * MIN, uk)).toBe('2 доб (48 год)');
    expect(fmtApproxParts(84.8 * 60 * MIN, uk)).toEqual({ main: '3 доб 12 год', hours: '(84 год)' });
    expect(fmtApproxParts(9.5 * 60 * MIN, uk)).toEqual({ main: '9 год 30 хв', hours: null });
    expect(fmtApprox(84.8 * 60 * MIN, uk)).toBe('3 доб 12 год (84 год)');
    expect(fmtApprox(167 * 60 * MIN, ru)).toBe('6 сут 23 ч (167 ч)');
    expect(fmtApprox(168 * 60 * MIN, ru)).toBe('> 7 сут');
    expect(fmtApprox(706 * 60 * MIN, dicts.en)).toBe('> 7 d');
  });

  it('fmtPower switches to kW after rounding', () => {
    expect(fmtPower(999.6, ru)).toBe('1.00 кВт');
    expect(fmtPower(999.4, ru)).toBe('999 Вт');
  });

  it('fmtPower shows kW with two decimals', () => {
    const uk = dicts.uk;
    const en = dicts.en;
    expect(fmtPower(4250, uk)).toBe('4.25 кВт');
    expect(fmtPower(999, uk)).toBe('999 Вт');
    expect(fmtPower(1000, uk)).toBe('1.00 кВт');
    expect(fmtPower(-3230, en)).toBe('3.23 kW');
  });

  it('fmtKwMax rounds before deciding on whole kW', () => {
    expect(fmtKwMax(9996)).toBe('10');
    expect(fmtKwMax(10004)).toBe('10');
    expect(fmtKwMax(8507)).toBe('8.51');
  });

  it('fmtKw and fmtKwMax', () => {
    expect(fmtKw(8432)).toBe('8.43');
    expect(fmtKwMax(10000)).toBe('10');
    expect(fmtKwMax(8470)).toBe('8.47');
  });
});

describe('renderEvent', () => {
  it('only live outage events become the panel; missed-while-down ones keep their text', () => {
    const ts = at('2026-11-04T12:30');
    const e = { type: 'outage_started' as const, ts, approxFromTs: null, missingPhases: ['L1', 'L2', 'L3'], reading: reading(ts, 72, -274, 211) };
    expect(eventMsg(e, cfg, ru, false).panel).toBe(true);
    const old = eventMsg(e, cfg, ru, true);
    expect(old.panel).toBeUndefined();
    expect(old.text).toContain('<blockquote>');
  });

  it('outage start and end are delivered as the panel', () => {
    const r = reading(at('2026-11-04T04:17'), 72, -274, 211);
    expect(renderEvent({ type: 'outage_started', ts: at('2026-11-04T04:17'), approxFromTs: null, missingPhases: ['L1', 'L2', 'L3'], reading: r }, cfg, ru).panel).toBe(true);
  });

  it('outage_started first line', () => {
    const m = renderEvent(
      { type: 'outage_started', ts: at('2026-11-04T04:17'), approxFromTs: null, missingPhases: ['L1', 'L2', 'L3'], reading: reading(at('2026-11-04T04:17'), 72, -274, 211) },
      cfg,
      ru,
    );
    expect(m.text.startsWith('<b>🔴 Свет пропал · 04:17</b>')).toBe(true);
    expect(m.silent).toBe(false);
    expect(m.text).toContain('72%');
    expect(m.text).toContain('211 Вт');
    expect(m.text).toContain('≈ 2 сут 22 ч (70 ч)');
  });

  it('partial phase loss names missing phase', () => {
    const m = renderEvent(
      { type: 'outage_started', ts: at('2026-11-04T04:17'), approxFromTs: null, missingPhases: ['L2'], reading: reading(at('2026-11-04T04:17'), 72, -274, 211, [230, 0, 230]) },
      cfg,
      ru,
    );
    expect(m.text).toContain('нет L2');
  });

  it('outage_ended shows duration and ETA', () => {
    const m = renderEvent(
      { type: 'outage_ended', ts: at('2026-11-04T15:02'), approxFromTs: null, startTs: at('2026-11-04T04:17'), reading: reading(at('2026-11-04T15:02'), 26, 3200, 400, [230, 230, 230]) },
      cfg,
      ru,
    );
    expect(m.text.startsWith('<b>🟢 Свет вернулся · 15:02</b>')).toBe(true);
    expect(m.text).toContain('10 ч 45 мин');
    expect(m.text).toContain('до 100% ≈ 5 ч 33 мин');
    expect(m.text).toContain('к ~20:35');
    expect(m.silent).toBe(false);
  });

  it('approx event uses between', () => {
    const m = renderEvent(
      { type: 'outage_started', ts: at('2026-11-04T04:25'), approxFromTs: at('2026-11-04T04:05'), missingPhases: ['L1', 'L2', 'L3'], reading: reading(at('2026-11-04T04:25'), 72, -274, 211) },
      cfg,
      ru,
    );
    expect(m.text).toContain('между 04:05 и 04:25');
  });

  it('battery_low first line', () => {
    const m = renderEvent(
      { type: 'battery_low', ts: at('2026-11-04T13:57'), threshold: 30, outageStartTs: at('2026-11-04T04:17'), reading: reading(at('2026-11-04T13:57'), 30, -380, 380) },
      cfg,
      ru,
    );
    expect(m.text.startsWith('<b>🪫 Батарея 30%</b>')).toBe(true);
    expect(m.silent).toBe(false);
  });

  it('battery_full and data events are silent', () => {
    expect(renderEvent({ type: 'battery_full', ts: at('2026-11-04T19:57'), chargeStartTs: at('2026-11-04T15:02') }, cfg, ru).silent).toBe(true);
    expect(renderEvent({ type: 'data_stale', sinceTs: at('2026-11-04T16:05') }, cfg, ru).silent).toBe(true);
    expect(renderEvent({ type: 'data_resumed', ts: at('2026-11-04T16:40'), gapFromTs: at('2026-11-04T16:05') }, cfg, ru).silent).toBe(true);
  });
});

describe('renderPanel', () => {
  it('panel stale warning', () => {
    const now = at('2026-11-04T05:29');
    const text = renderPanel(
      { reading: reading(now - 20 * MIN, 72, -274, 211), grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false }, outageStartTs: at('2026-11-04T04:17'), lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: null },
      cfg,
      ru,
    );
    expect(text).toContain('Нет свежих данных');
  });

  it('panel shows outage header and runtime', () => {
    const now = at('2026-11-04T05:29');
    const text = renderPanel(
      { reading: reading(now - 2 * MIN, 72, -274, 211), grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false }, outageStartTs: at('2026-11-04T04:17'), lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: null },
      cfg,
      ru,
    );
    expect(text).toContain('🔴 <b>Света нет</b> · дом на батареях');
    expect(text).toContain('1 ч 12 мин');
    expect(text).toContain('🟩🟩🟩🟩🟩🟩🟩⬜⬜⬜');
    expect(text).toContain('хватит ≈ <b>2 сут 22 ч (70 ч)</b>');
    expect(text).toContain('обновлено 2 мин назад');
    expect(text).not.toContain('<pre>');
  });

  it('panel shows grid draw while charging from the grid', () => {
    const now = at('2026-11-04T18:44');
    const r = { ...reading(now - MIN, 85, 4100, 2900), gridPowerW: 7000, gridVoltages: [222, 222, 222] };
    const text = renderPanel({ reading: r, grid: { state: 'on', missingPhases: [], ambiguous: false }, outageStartTs: null, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: { chargeA: 150, dischargeA: 180 } }, cfg, ru);
    expect(text).toContain('⚡ Из сети <b>7.00 кВт</b> · дом 2.90 · батареи 4.10');
  });

  it('panel shows battery draw against the limit during an outage', () => {
    const now = at('2026-11-04T05:29');
    const r = { ...reading(now - MIN, 60, -2400, 2400), batteryVoltage: 54.3, ratedPowerW: 10_000 };
    const text = renderPanel({ reading: r, grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false }, outageStartTs: now - 60 * MIN, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: { chargeA: 150, dischargeA: 180 } }, cfg, ru);
    expect(text).toContain('⚡ От батарей <b>2.40 кВт</b> · предел ≈ 8.70 кВт');
  });
});

describe('renderAccessRequest', () => {
  it('escapes html', () => {
    expect(renderAccessRequest('<b>x', null, ru)).toContain('&lt;b&gt;x');
  });
});

describe('stats rendering', () => {
  const H = 3_600_000;
  const sum = { onMs: 18 * H, offMs: 6 * H, unknownMs: 0, outageCount: 2, longestOutage: { start: at('2026-11-03T04:00'), ms: 4 * H } };
  const range = { from: at('2026-11-03T00:00'), to: at('2026-11-04T00:00') };

  it('day: no code block, strip split into two rows of 12', () => {
    const strip = '🟩'.repeat(4) + '🟥'.repeat(4) + '🟩'.repeat(16);
    const text = renderDay('2026-11-03', sum, strip, [], null, 0, cfg, range, at('2026-11-05T00:00'), range.from, ru);
    expect(text).not.toContain('<pre>');
    expect(text).toContain('00 🟩🟩🟩🟩🟥🟥🟥🟥🟩🟩🟩🟩');
    expect(text).toContain('12 ' + '🟩'.repeat(12));
    expect(text).toContain('<b>18 ч</b>');
  });

  it('week: one line per day, no code block', () => {
    const allDay = { onMs: 24 * H, offMs: 0, unknownMs: 0, outageCount: 0, longestOutage: null };
    const text = renderWeek('2 – 8 ноября', [{ label: 'Пн 02', sum }, { label: 'Вт 03', sum: allDay }], sum, null, cfg, ru);
    expect(text).not.toContain('<pre>');
    expect(text).toContain('<b>Пн 02</b>');
    expect(text).toContain('6 ч');
    expect(text).toContain('весь день');
  });
});
