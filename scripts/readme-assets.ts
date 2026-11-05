// README images: real cards rendered by the bot's own code with demo data, plus the banner built from them.
// Run: npm run readme-assets  →  docs/readme/*.png
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import { emptyReading } from '../src/deye/types.js';
import { buildTimeline, dayRange, summarize } from '../src/domain/stats.js';
import { monthSummary } from '../src/domain/energy.js';
import { batteryModel, dayModel, moneyModel, panelModel, periodModel, scheduleModel } from '../src/render/models.js';
import { CARD_W, svgBattery, svgDay, svgMoney, svgPanel, svgPeriod, svgSchedule } from '../src/render/cards.js';
import { toPng } from '../src/render/png.js';
import { parsePlanned } from '../src/schedule/yasno.js';
import { dicts } from '../src/i18n/index.js';

const OUT = 'docs/readme';
mkdirSync(OUT, { recursive: true });

const t = dicts.en;
const cfg = loadConfig({ TELEGRAM_TOKEN: 't', ADMIN_TELEGRAM_ID: '1', DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p' });
const z = cfg.timezone;
const at = (iso: string) => DateTime.fromISO(iso, { zone: z }).toMillis();
const MIN = 60_000;
const H = 60 * MIN;
const now = at('2026-11-04T20:59');

const cards: Record<string, Buffer> = {};
const save = (name: string, svg: string) => {
  cards[name] = toPng(svg, CARD_W);
  writeFileSync(`${OUT}/${name}.png`, cards[name]);
};

// --- panel: charging, scheduled outage ahead ---
const base = { ...emptyReading(now - MIN), batteryVoltage: 52.8, batteryTempC: 26, pvPowerW: 0, batteryCapacityKwh: 23.552, ratedPowerW: 10_000 };
const on = { state: 'on' as const, missingPhases: [], ambiguous: false };
const ctx = { grid: on, outageStartTs: null, lastOnTs: null, nowMs: now, staleAfterMs: 15 * MIN, limits: { chargeA: 150, dischargeA: 180 } };
save(
  'panel',
  svgPanel(
    panelModel(
      {
        ...ctx,
        reading: { ...base, soc: 80, batteryPowerW: 4000, upsLoadPowerW: 1100, gridPowerW: 5100, gridVoltages: [230, 230, 230] },
        schedule: { state: { kind: 'next', start: at('2026-11-04T22:00'), end: at('2026-11-05T06:00') }, stale: false, fetchedAt: now },
      } as never,
      cfg,
      t,
    ),
  ),
);

// --- panel: outage, on batteries ---
save(
  'panel-outage',
  svgPanel(
    panelModel(
      {
        ...ctx,
        grid: { state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false },
        outageStartTs: now - 2 * H - 17 * MIN,
        reading: { ...base, soc: 64, batteryVoltage: 51.6, batteryPowerW: -1400, upsLoadPowerW: 1400, gridPowerW: 0, gridVoltages: [0, 0, 0] },
        schedule: { state: { kind: 'off-until', until: at('2026-11-05T00:00'), endsAtDayEdge: false }, stale: false, fetchedAt: now },
      } as never,
      cfg,
      t,
    ),
  ),
);

// --- outage schedule (YASNO), today + tomorrow ---
const fx = JSON.parse(readFileSync('tests/fixtures/yasno/planned-outages.json', 'utf8'));
const s = parsePlanned(fx, '52.1', now - 30 * MIN);
const s2 = {
  ...s,
  days: [
    s.days[0]!,
    { date: '2026-11-05', status: 'applies' as const, outages: [{ start: at('2026-11-05T00:00'), end: at('2026-11-05T06:00') }, { start: at('2026-11-05T14:00'), end: at('2026-11-05T18:00') }] },
  ],
};
save('schedule', svgSchedule(scheduleModel(s2, { kind: 'next', start: at('2026-11-04T22:00'), end: at('2026-11-05T06:00') } as never, false, now, cfg, t)));

// --- battery health ---
save(
  'battery',
  svgBattery(
    batteryModel(
      {
        nominalKwh: 23.552,
        capacity: { estimateKwh: 22.8, pct: 97, trendPct: -1 },
        cycles: 48.4,
        ratedCycles: 6000,
        wear: { byCyclesPct: 0.8, byCapacityPct: 3.2 },
        tempNow: 27,
        tempMax30: 38,
        hoursAbove35: 2.5,
        hoursAboveLimit: 0,
        limitC: 45,
        today: '2026-11-04',
        days: Array.from({ length: 30 }, (_, i) => ({ date: DateTime.fromISO('2026-10-06').plus({ days: i }).toISODate()!, maxTempC: 24 + ((i * 7) % 16) })),
      },
      t,
    ),
  ),
);

// --- one day of outages ---
const dn = at('2026-11-09T18:44');
const { from, to } = dayRange('2026-11-09', z);
const outages = [
  { start: at('2026-11-09T01:00'), end: at('2026-11-09T04:30') },
  { start: at('2026-11-09T09:00'), end: at('2026-11-09T12:40') },
  { start: at('2026-11-09T16:00'), end: at('2026-11-09T17:10') },
];
const segs = buildTimeline(from, to, outages, [], dn);
save('day', svgDay(dayModel('2026-11-09', segs, summarize(segs, outages, from, to), outages, { soc: 41, ts: at('2026-11-09T12:35') }, 9.4, cfg, { from, to }, dn, at('2026-11-01T00:00'), t)));

// --- week ---
const sum = (onH: number, off: number, n: number) => ({ onMs: onH * H, offMs: off * H, unknownMs: 0, outageCount: n, longestOutage: off ? { start: at('2026-11-05T18:10'), ms: 4 * H } : null });
const wk = DateTime.fromISO('2026-11-02', { zone: z }).setLocale(t.locale);
const rows = [sum(16, 8, 3), sum(24, 0, 0), sum(20, 4, 1), sum(14, 10, 4), sum(20, 4, 1), sum(18, 6, 2), sum(22, 2, 1)].map((x, i) => ({ label: wk.plus({ days: i }).toFormat('ccc dd'), sum: x, spanMs: 24 * H }));
save('week', svgPeriod(periodModel(`${wk.toFormat('d MMM')} – ${wk.plus({ days: 6 }).toFormat('d MMM')}`, rows, sum(134, 34, 12), sum(120, 48, 15), cfg, t)));

// --- spending ---
const tariff = { dayPrice: 4.32, nightPrice: 2.16, nightFrom: 23, nightTo: 7 };
const days = Array.from({ length: 9 }, (_, i) => ({ date: `2026-11-0${i + 1}`, dayKwh: 6 + ((i * 5) % 7), nightKwh: 9 + ((i * 3) % 5), consumption: 20, charge: 9, discharge: 7, pv: 1.2 }));
const mn = at('2026-11-09T18:44');
save('money', svgMoney(moneyModel(monthSummary(days, tariff, '2026-11', mn, z, at('2026-11-01T00:00')), '2026-11', tariff, days, mn, cfg, t)));

// ================= banner =================
const W = 1280;
const BH = 640;
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

/** A card as a phone-like floating sheet: rounded, outlined, with a soft shadow. */
function sheet(name: string, x: number, y: number, w: number, rot: number, id: string): string {
  const { w: pw, h: ph } = pngSize(cards[name]!);
  const h = Math.round((w * ph) / pw);
  const r = 22;
  return `<g transform="rotate(${rot} ${x + w / 2} ${y + h / 2})">
  <rect x="${x}" y="${y + 18}" width="${w}" height="${h}" rx="${r}" fill="#000" opacity="0.55" filter="url(#shadow)"/>
  <clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>
  <image href="${uri(cards[name]!)}" x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#${id})" preserveAspectRatio="none"/>
  <rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.14"/>
</g>`;
}

function chip(x: number, y: number, label: string, color: string): { svg: string; w: number } {
  const w = Math.round(label.replace(/&amp;/g, '&').length * 8.3 + 50);
  return {
    w,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="38" rx="19" fill="#ffffff" fill-opacity="0.05" stroke="#ffffff" stroke-opacity="0.10"/>
<circle cx="${x + 19}" cy="${y + 19}" r="5" fill="${color}"/>
<text x="${x + 32}" y="${y + 25}" font-size="16" font-weight="500" fill="#c7d0e3">${label}</text>`,
  };
}

const chipRows = [
  [
    ['Outage alerts', '#34d399'],
    ['Battery runtime', '#fbbf24'],
    ['YASNO schedule', '#60a5fa'],
  ],
  [
    ['Spending &amp; tariffs', '#a78bfa'],
    ['Battery health', '#f87171'],
    ['uk · ru · en', '#8b97b0'],
  ],
];
let chips = '';
chipRows.forEach((row, ri) => {
  let cx = 80;
  for (const [label, color] of row) {
    const c = chip(cx, 384 + ri * 50, label!, color!);
    chips += c.svg;
    cx += c.w + 10;
  }
});

// Lightning-in-a-battery mark
const logo = `<g transform="translate(80 92)">
  <rect width="64" height="64" rx="18" fill="url(#logoBg)"/>
  <rect x="0.5" y="0.5" width="63" height="63" rx="17.5" fill="none" stroke="#ffffff" stroke-opacity="0.25"/>
  <path d="M36 12 L20 36 H31 L28 52 L44 28 H33 Z" fill="#0a0f1d"/>
</g>`;

const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BH}" viewBox="0 0 ${W} ${BH}" font-family="Inter">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#18213a"/><stop offset="1" stop-color="#080c18"/></linearGradient>
  <radialGradient id="glowG" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#10b981" stop-opacity="0.38"/><stop offset="1" stop-color="#10b981" stop-opacity="0"/></radialGradient>
  <radialGradient id="glowV" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#6d5dfc" stop-opacity="0.30"/><stop offset="1" stop-color="#6d5dfc" stop-opacity="0"/></radialGradient>
  <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#2a3b6b" stop-opacity="0.7"/><stop offset="1" stop-color="#2a3b6b" stop-opacity="0"/></radialGradient>
  <linearGradient id="logoBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6ee7b7"/><stop offset="1" stop-color="#10b981"/></linearGradient>
  <linearGradient id="title" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9f5dc"/></linearGradient>
  <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#ffffff" fill-opacity="0.06"/></pattern>
  <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="1"/></linearGradient>
  <mask id="dotsMask"><rect width="${W}" height="${BH}" fill="url(#fade)"/></mask>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
</defs>
<rect width="${W}" height="${BH}" fill="url(#bg)"/>
<rect width="${W}" height="${BH}" fill="url(#dots)" mask="url(#dotsMask)"/>
<ellipse cx="200" cy="40" rx="520" ry="360" fill="url(#glowB)"/>
<ellipse cx="930" cy="330" rx="430" ry="380" fill="url(#glowG)"/>
<ellipse cx="1210" cy="620" rx="380" ry="300" fill="url(#glowV)"/>

${logo}
<text x="164" y="122" font-size="15" font-weight="600" fill="#6ee7b7" letter-spacing="2.4">TELEGRAM BOT</text>
<text x="164" y="148" font-size="15" font-weight="500" fill="#8b97b0">for Deye hybrid inverters</text>

<text x="76" y="262" font-size="88" font-weight="800" fill="url(#title)" letter-spacing="-2.5">Deye Home</text>
<text x="80" y="314" font-size="22" font-weight="500" fill="#a9b4cb">Know when the power goes out, how long the</text>
<text x="80" y="344" font-size="22" font-weight="500" fill="#a9b4cb">batteries will last — and what the grid costs you.</text>

${chips}

<text x="80" y="566" font-size="15" font-weight="500" fill="#5b6680">Read-only · self-hosted · Docker on a NAS · one family, shared access</text>

${sheet('schedule', 690, 196, 300, -7, 'c1')}
${sheet('battery', 985, 214, 290, 6, 'c2')}
${sheet('panel', 832, 92, 330, 0, 'c3')}
</svg>`;

writeFileSync(`${OUT}/banner.png`, toPng(banner, W));
console.log(`ok → ${OUT}/`, Object.keys(cards).join(', '), '+ banner');
