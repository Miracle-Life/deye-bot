// Text-fit check: every card × uk/ru/en × edge-case data → tmp/preview/*.png. Look at every image.
// Run: npm run preview
import { mkdirSync, writeFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import { emptyReading } from '../src/deye/types.js';
import { buildTimeline, dayRange, summarize } from '../src/domain/stats.js';
import { monthSummary } from '../src/domain/energy.js';
import { dicts, type Lang } from '../src/i18n/index.js';
import { monthArchiveModel, quarterArchiveModel, svgArchiveMonth, svgArchiveQuarter, svgArchiveWeek, weekArchiveModel } from '../src/render/archive.js';
import { CARD_W, svgBattery, svgDay, svgMoney, svgPanel, svgPeriod, svgSchedule } from '../src/render/cards.js';
import { batteryModel, dayModel, moneyModel, panelModel, periodModel, scheduleModel } from '../src/render/models.js';
import { toPng } from '../src/render/png.js';
import type { ArchiveDayStat } from '../src/schedule/archive.js';

const OUT = 'tmp/preview';
mkdirSync(OUT, { recursive: true });
const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
const z = cfg.timezone;
const at = (iso: string) => DateTime.fromISO(iso, { zone: z }).toMillis();
const MIN = 60_000;
const H = 60 * MIN;
const now = at('2026-11-08T20:59');
let count = 0;
const save = (name: string, svg: string) => {
  writeFileSync(`${OUT}/${name}.png`, toPng(svg, CARD_W));
  count++;
};

const base = { ...emptyReading(now - MIN), batteryVoltage: 54.84, batteryTempC: 26, pvPowerW: 0, batteryCapacityKwh: 23.552, ratedPowerW: 10_000 };
const on = { state: 'on' as const, missingPhases: [], ambiguous: false };
const off = { state: 'off' as const, missingPhases: ['L1', 'L2', 'L3'], ambiguous: false };
const ctx = { grid: on, outageStartTs: null, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: { chargeA: 150, dischargeA: 180 } };
const sched = { state: { kind: 'off-until', until: at('2026-11-09T05:30'), endsAtDayEdge: false }, stale: false, fetchedAt: now, dischargeW: 8490 };

const panels: Record<string, object> = {
  'grid-red': { ...ctx, reading: { ...base, soc: 96, batteryPowerW: 4154, upsLoadPowerW: 5716, gridPowerW: 9870, gridVoltages: [230, 230, 230] } },
  'grid-low': { ...ctx, reading: { ...base, soc: 100, batteryPowerW: 0, upsLoadPowerW: 60, gridPowerW: 60, gridVoltages: [230, 230, 230] } },
  'grid-back': { ...ctx, lastOnTs: now - 5 * MIN, lastOutageStartTs: now - 23 * H - 59 * MIN - 5 * MIN, reading: { ...base, soc: 12, batteryPowerW: 4154, upsLoadPowerW: 4000, gridPowerW: 8154, gridVoltages: [230, 230, 230] } },
  'outage-red': { ...ctx, grid: off, outageStartTs: now - 23 * H - 59 * MIN, reading: { ...base, soc: 7, batteryVoltage: 49.2, batteryPowerW: -8490, upsLoadPowerW: 8490, gridPowerW: 0, gridVoltages: [0, 0, 0] }, schedule: sched },
  'outage-nolimits': { ...ctx, limits: null, grid: off, outageStartTs: now - 17 * MIN, reading: { ...base, soc: 93, batteryPowerW: -1050, upsLoadPowerW: 1000, gridPowerW: 0, gridVoltages: [0, 0, 0] } },
  'grid-idle-full': { ...ctx, reading: { ...base, soc: 100, batteryPowerW: -45, upsLoadPowerW: 1420, gridPowerW: 1420, gridVoltages: [234, 234, 234] } },
  'grid-idle-part': { ...ctx, reading: { ...base, soc: 36, batteryPowerW: 30, upsLoadPowerW: 9870, gridPowerW: 9870, gridVoltages: [234, 234, 234] } },
  stale: { ...ctx, reading: { ...base, ts: now - 3 * H, soc: 55, batteryPowerW: -300, upsLoadPowerW: 300, gridPowerW: 0, gridVoltages: [230, 230, 230] } },
};

const stat = (date: string, kind: ArchiveDayStat['kind'], spans: [string, string][], actualH: number | null, dayH = 24): ArchiveDayStat => {
  const s = spans.map(([a, b]) => ({ start: at(`${date}T${a}`), end: b === '24:00' ? DateTime.fromISO(date, { zone: z }).plus({ days: 1 }).toMillis() : at(`${date}T${b}`) }));
  return { date, kind, spans: s, plannedMs: s.reduce((x, y) => x + y.end - y.start, 0), actualMs: actualH === null ? null : actualH * H, dayMs: dayH * H };
};
// Long texts: 23.5 h planned, (23.5) actual, "— (12.5)", emergency, no data, a 25 h DST day.
const week = [
  stat('2026-10-19', 'planned', [['00:00', '23:30']], 23.5),
  stat('2026-10-20', 'planned', [], 12.5),
  stat('2026-10-21', 'emergency', [], 23.5),
  stat('2026-10-22', 'nodata', [], null),
  stat('2026-10-23', 'planned', [['00:30', '04:00'], ['07:30', '11:00'], ['14:30', '18:00'], ['21:30', '24:00']], 12.5),
  stat('2026-10-24', 'planned', [['18:00', '22:00']], 3.5),
  stat('2026-10-25', 'planned', [['00:00', '24:00']], 24.5, 25),
];
const monthOf = (monthIso: string) => {
  const d0 = DateTime.fromISO(`${monthIso}-01`, { zone: z });
  return Array.from({ length: d0.daysInMonth! }, (_, i) => {
    const d = d0.plus({ days: i }).toISODate()!;
    if (i === 13) return stat(d, 'emergency', [], 23.5);
    if (i < 2) return stat(d, 'nodata', [], null);
    return stat(d, 'planned', i % 4 ? [['00:00', '23:30']] : [], 23.5);
  });
};
const weeks = Array.from({ length: 13 }, (_, w) =>
  Array.from({ length: 7 }, (_, d) => {
    const date = DateTime.fromISO('2026-08-10', { zone: z }).plus({ weeks: w, days: d }).toISODate()!;
    return stat(date, d === 3 ? 'emergency' : 'planned', d === 3 ? [] : [['00:00', '24:00']], 24);
  }),
);
const weeksFew = weeks.map((w, i) => (i < 8 ? w.map((d) => ({ ...d, kind: 'nodata' as const, spans: [], plannedMs: 0, actualMs: null })) : w));

for (const lang of Object.keys(dicts) as Lang[]) {
  const t = dicts[lang];
  for (const [name, c] of Object.entries(panels)) save(`panel-${name}-${lang}`, svgPanel(panelModel(c as never, cfg, t)));

  const s = {
    group: '52.1',
    updatedAt: now - H,
    fetchedAt: now - 30 * MIN,
    unknownTypes: [],
    days: [
      { date: '2026-11-08', status: 'applies' as const, outages: [{ start: at('2026-11-08T00:30'), end: at('2026-11-08T04:00') }, { start: at('2026-11-08T07:30'), end: at('2026-11-08T11:00') }, { start: at('2026-11-08T14:30'), end: at('2026-11-08T18:00') }, { start: at('2026-11-08T21:30'), end: at('2026-11-09T00:00') }] },
      { date: '2026-11-09', status: 'emergency' as const, outages: [] },
    ],
  };
  save(`schedule-${lang}`, svgSchedule(scheduleModel(s, { kind: 'off-until', until: at('2026-11-09T00:00'), endsAtDayEdge: true } as never, true, now, cfg, t)));

  save(`archive-week-${lang}`, svgArchiveWeek(weekArchiveModel(week, '52.1', now, cfg, t)));
  save(`archive-month-oct-${lang}`, svgArchiveMonth(monthArchiveModel(monthOf('2026-10'), '2026-10', '52.1', now, cfg, t)));
  save(`archive-month-mar-${lang}`, svgArchiveMonth(monthArchiveModel(monthOf('2026-03'), '2026-03', '52.1', now, cfg, t))); // 31 days, starts on Sunday
  save(`archive-quarter-${lang}`, svgArchiveQuarter(quarterArchiveModel(weeks, '52.1', now, cfg, t)));
  save(`archive-quarter-few-${lang}`, svgArchiveQuarter(quarterArchiveModel(weeksFew, null, now, cfg, t)));

  // Unchanged cards: regressions only.
  const { from, to } = dayRange('2026-11-07', z);
  const outages = [{ start: at('2026-11-07T00:30'), end: at('2026-11-07T23:50') }];
  const segs = buildTimeline(from, to, outages, [], now);
  save(`day-${lang}`, svgDay(dayModel('2026-11-07', segs, summarize(segs, outages, from, to), outages, { soc: 7, ts: at('2026-11-07T23:40') }, 23.4, cfg, { from, to }, now, at('2026-11-01T00:00'), t)));
  const sum = (onH: number, offH: number) => ({ onMs: onH * H, offMs: offH * H, unknownMs: 0, outageCount: 9, longestOutage: { start: at('2026-11-05T18:10'), ms: 23 * H } });
  const wk = DateTime.fromISO('2026-11-02', { zone: z }).setLocale(t.locale);
  const rows = Array.from({ length: 7 }, (_, i) => ({ label: wk.plus({ days: i }).toFormat('ccc dd'), sum: sum(1, 23), spanMs: 24 * H }));
  save(`week-${lang}`, svgPeriod(periodModel(`${wk.toFormat('d MMM')} – ${wk.plus({ days: 6 }).toFormat('d MMM')}`, rows, sum(7, 161), sum(120, 48), cfg, t)));
  const tariff = { dayPrice: 4.32, nightPrice: 2.16, nightFrom: 23, nightTo: 7 };
  const days = Array.from({ length: 8 }, (_, i) => ({ date: `2026-11-0${i + 1}`, dayKwh: 60 + i, nightKwh: 40, consumption: 100, charge: 20, discharge: 20, pv: 0 }));
  save(`money-${lang}`, svgMoney(moneyModel(monthSummary(days, tariff, '2026-11', now, z, at('2026-11-01T00:00')), '2026-11', tariff, days, now, cfg, t)));
  save(
    `battery-${lang}`,
    svgBattery(
      batteryModel(
        {
          nominalKwh: 23.552,
          capacity: { estimateKwh: 22.8, pct: 97, trendPct: -1.4 },
          cycles: 1048.4,
          ratedCycles: 6000,
          wear: { byCyclesPct: 17.5, byCapacityPct: 3.2 },
          tempNow: 46,
          tempMax30: 48,
          hoursAbove35: 125.5,
          hoursAboveLimit: 12.5,
          limitC: 45,
          today: '2026-11-08',
          days: Array.from({ length: 30 }, (_, i) => ({ date: DateTime.fromISO('2026-10-10').plus({ days: i }).toISODate()!, maxTempC: 24 + ((i * 7) % 26) })),
        },
        t,
      ),
    ),
  );
}
console.log(`${count} cards → ${OUT}/`);
