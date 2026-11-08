import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { dicts } from '../src/i18n/index.js';
import { monthArchiveModel, quarterArchiveModel, svgArchiveMonth, svgArchiveQuarter, svgArchiveWeek, weekArchiveModel } from '../src/render/archive.js';
import type { ArchiveDayStat } from '../src/schedule/archive.js';

const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
const Z = 'Europe/Kyiv';
const H = 3_600_000;
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();
const uk = dicts.uk;
const now = at('2026-11-08T20:00');

const stat = (date: string, kind: ArchiveDayStat['kind'], plannedH: number, actualH: number | null): ArchiveDayStat => ({
  date,
  kind,
  spans: plannedH ? [{ start: at(`${date}T10:00`), end: at(`${date}T10:00`) + plannedH * H }] : [],
  plannedMs: plannedH * H,
  actualMs: actualH === null ? null : actualH * H,
  dayMs: 24 * H,
});

const week = [
  stat('2026-11-02', 'planned', 4.5, 4),
  stat('2026-11-03', 'planned', 0, 2),
  stat('2026-11-04', 'emergency', 0, 6),
  stat('2026-11-05', 'nodata', 0, 1),
  stat('2026-11-06', 'planned', 8, 7.5),
  stat('2026-11-07', 'planned', 12, 12),
  stat('2026-11-08', 'planned', 9, 0.5),
];

describe('week archive card', () => {
  it('rows: planned (actual), dash, emergency, no data', () => {
    const m = weekArchiveModel(week, '52.1', now, cfg, uk);
    expect(m.rows.map((r) => [r.text, r.sub])).toEqual([
      ['4.5 год', '(4)'],
      ['—', '(2)'],
      ['аварійні', '(6)'],
      ['немає даних', ''],
      ['8 год', '(7.5)'],
      ['12 год', '(12)'],
      ['9 год', '(0.5)'],
    ]);
    expect(m.rows[0]!.label).toBe('Пн 2');
    expect(m.title).toBe('Графік · тиждень');
    expect(m.subtitle).toBe('2 – 8 листопада · група 52.1');
  });

  it('stats: planned total with actual in brackets', () => {
    const m = weekArchiveModel(week, '52.1', now, cfg, uk);
    // planned: 4.5 + 0 + 8 + 12 + 9 = 33.5; actual over known days: 4 + 2 + 6 + 7.5 + 12 + 0.5 = 32
    expect(m.stats[0]).toMatchObject({ value: '33.5 год', sub: '(32)' });
    expect(m.stats[1]!.value).toBe('4 з 6');
  });
});

describe('month archive card', () => {
  const october = Array.from({ length: 31 }, (_, i) => stat(`2026-10-${String(i + 1).padStart(2, '0')}`, i === 13 ? 'emergency' : 'planned', i % 3 ? 4 : 0, 3));

  it('calendar starts on the right weekday and marks emergency days', () => {
    const m = monthArchiveModel(october, '2026-10', '52.1', now, cfg, uk);
    expect(m.cells).toHaveLength(31);
    expect(m.offset).toBe(3); // 1 October 2026 is a Thursday
    expect(m.cells[13]!.kind).toBe('emergency');
    expect(m.cells[1]!.lines).toEqual(['4г', '(3)']);
    expect(m.title).toBe('Графік · жовтень 2026');
  });
});

describe('quarter archive card', () => {
  const weeks = Array.from({ length: 13 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => stat(DateTime.fromISO('2026-08-10').plus({ weeks: w, days: d }).toISODate()!, w < 6 ? 'nodata' : 'planned', 4, 3)),
  );

  it('13 week rows × 7 day cells; no trend without 8 known weeks', () => {
    const m = quarterArchiveModel(weeks, '52.1', now, cfg, uk);
    expect(m.rows).toHaveLength(13);
    expect(m.rows.every((r) => r.cells.length === 7)).toBe(true);
    expect(m.rows[0]!.label).toBe('10.08');
    expect([m.rows[6]!.text, m.rows[6]!.sub]).toEqual(['28', '(21)']);
    expect([m.rows[0]!.text, m.rows[0]!.sub]).toEqual(['—', '']);
    expect(m.weekdays).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']);
    expect(m.stats.map((s) => s.label)).not.toContain(uk.archive.trend);
  });
});

describe('quarter trend', () => {
  it('a rounded 0 % has no arrow', () => {
    const flat = Array.from({ length: 13 }, (_, w) => Array.from({ length: 7 }, (_, d) => stat(DateTime.fromISO('2026-08-10').plus({ weeks: w, days: d }).toISODate()!, 'planned', w === 12 && d === 0 ? 4.01 : 4, 3)));
    const m = quarterArchiveModel(flat, '52.1', now, cfg, uk);
    expect(m.stats.find((s) => s.label === uk.archive.trend)).toMatchObject({ value: '0%', tone: 'plain' });
  });
});

describe('archive SVG', () => {
  it('renders valid SVG without NaN/undefined in every language', () => {
    const october = Array.from({ length: 31 }, (_, i) => stat(`2026-10-${String(i + 1).padStart(2, '0')}`, 'planned', 4, 3));
    const weeks = Array.from({ length: 13 }, () => week);
    for (const t of Object.values(dicts)) {
      for (const svg of [
        svgArchiveWeek(weekArchiveModel(week, '52.1', now, cfg, t)),
        svgArchiveMonth(monthArchiveModel(october, '2026-10', '52.1', now, cfg, t)),
        svgArchiveQuarter(quarterArchiveModel(weeks, '52.1', now, cfg, t)),
      ]) {
        expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
        expect(svg).not.toMatch(/NaN|undefined/);
      }
    }
  });
});
