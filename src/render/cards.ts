// SVG templates for the image cards. Layout is fixed-width; text widths are estimated.
import type { LoadZone } from '../domain/load.js';
import type { BatteryCardModel, DayModel, Icon, LoadBlock, MoneyModel, PanelModel, PeriodModel, ScheduleCardModel, ScheduleTile, Stat, Tone } from './models.js';

export const CARD_W = 540;

export const C = {
  bg0: '#151c2f',
  bg1: '#0a0f1d',
  tile: 'rgba(255,255,255,0.05)',
  tileStroke: 'rgba(255,255,255,0.08)',
  text: '#ffffff',
  muted: '#8b97b0',
  dim: '#5b6680',
  green: '#34d399',
  greenDeep: '#10b981',
  red: '#f87171',
  redDeep: '#ef4444',
  amber: '#fbbf24',
  amberDeep: '#f59e0b',
  orange: '#fb923c',
  orangeDeep: '#f97316',
  blue: '#60a5fa',
  violet: '#a78bfa',
  unknown: '#3b4559',
  future: 'rgba(255,255,255,0.06)',
};

export const TONE: Record<Tone, string> = { green: C.green, red: C.red, amber: C.amber, plain: C.text, muted: C.muted };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Rough Inter advance width (em) — good enough for pills and inline units.
const textW = (s: string, size: number, weight = 600) => s.length * size * (weight >= 700 ? 0.6 : 0.56);

/** Font size for a medium-weight label that must fit `maxW`. */
const fitLabel = (s: string, maxW: number) => Math.floor((maxW / (s.length * 0.53)) * 10) / 10;

/** Bold font size that keeps `s` within `maxW` (longer units in some languages). */
export const fitFont = (s: string, maxW: number, base: number) => Math.min(base, Math.floor((maxW / (s.length * 0.6)) * 10) / 10);

export function frame(h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${h}" viewBox="0 0 ${CARD_W} ${h}" font-family="Inter">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
  <radialGradient id="glow" cx="0.15" cy="0" r="0.9"><stop offset="0" stop-color="#2a3b6b" stop-opacity="0.55"/><stop offset="1" stop-color="#2a3b6b" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${CARD_W}" height="${h}" fill="url(#bg)"/>
<rect width="${CARD_W}" height="${h}" fill="url(#glow)"/>
${body}
</svg>`;
}

function icon(name: Icon, x: number, y: number, color: string, size = 18): string {
  const s = size / 24;
  const paths: Record<Icon, string> = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    grid: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 10v4M10 10v4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  };
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</g>`;
}

function pill(x: number, y: number, label: string, kind: 'on' | 'off' | 'unknown'): string {
  const color = kind === 'off' ? C.red : kind === 'on' ? C.green : C.muted;
  const deep = kind === 'off' ? C.redDeep : kind === 'on' ? C.greenDeep : C.dim;
  const w = textW(label, 14) + 44;
  return `<rect x="${x}" y="${y}" width="${w}" height="32" rx="16" fill="${deep}" fill-opacity="0.16" stroke="${deep}" stroke-opacity="0.45"/>
<circle cx="${x + 18}" cy="${y + 16}" r="8" fill="${deep}" fill-opacity="0.25"/>
<circle cx="${x + 18}" cy="${y + 16}" r="4.5" fill="${deep}"/>
<text x="${x + 32}" y="${y + 21}" font-size="14" font-weight="600" fill="${color}">${esc(label)}</text>`;
}

// Battery ring: seven equal 15 % steps, deep red → emerald.
const RING_STEPS: [number, string][] = [
  [90, '#10b981'],
  [75, '#4ade80'],
  [60, '#a3e635'],
  [45, '#facc15'],
  [30, '#f97316'],
  [15, '#ef4444'],
  [0, '#b91c1c'],
];

export const ringColor = (pct: number) => RING_STEPS.find(([from]) => pct >= from)?.[1] ?? RING_STEPS.at(-1)![1];

function ring(cx: number, cy: number, r: number, soc: number | null, sub: string | null): string {
  const circ = 2 * Math.PI * r;
  const pct = soc === null ? 0 : Math.max(0, Math.min(100, soc));
  const arc =
    soc === null
      ? ''
      : `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${ringColor(pct)}" stroke-width="14" fill="none" stroke-linecap="round" stroke-dasharray="${((circ * pct) / 100).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="rgba(255,255,255,0.08)" stroke-width="14" fill="none"/>
${arc}
<text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="38" font-weight="800" fill="${C.text}">${soc === null ? '—' : `${Math.round(pct)}%`}</text>
${sub ? `<text x="${cx}" y="${cy + 30}" text-anchor="middle" font-size="13" font-weight="500" fill="${C.muted}">${esc(sub)}</text>` : ''}`;
}

function tile(x: number, y: number, w: number, h: number, t: PanelModel['tiles'][number]): string {
  const iconColor = { home: C.blue, sun: C.amber, grid: t.tone === 'red' ? C.red : C.green, battery: C.violet, moon: C.violet, calendar: C.blue }[t.icon];
  const valueColor = t.tone ? TONE[t.tone] : C.text;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.tile}" stroke="${C.tileStroke}"/>
${icon(t.icon, x + 16, y + 15, iconColor)}
<text x="${x + 42}" y="${y + 29}" font-size="14" font-weight="500" fill="${C.muted}">${esc(t.label)}</text>
${t.aside ? `<text x="${x + w - 16}" y="${y + 29}" text-anchor="end" font-size="13" font-weight="500" fill="${C.muted}">${esc(t.aside)}</text>\n` : ''}<text x="${x + 16}" y="${y + 66}"><tspan font-size="26" font-weight="700" fill="${valueColor}">${esc(t.value)}</tspan><tspan dx="6" font-size="14" font-weight="500" fill="${C.muted}">${esc(t.unit)}</tspan></text>`;
}

const ZONE: Record<LoadZone, string> = { green: C.green, yellow: C.amber, orange: C.orange, red: C.red };
const LOAD_H = 140; // bar, zone strip, legend, then the limit line
const HOME_C = '#38bdf8'; // load bar: what the house takes
const CHARGE_C = '#e879f9'; // load bar: what charging takes
const INVERTER_C = '#94a3b8'; // load bar: the inverter's own use and conversion
const SEGMENT_C: Record<LoadBlock['segments'][number]['kind'], string> = { home: HOME_C, charge: CHARGE_C, inverter: INVERTER_C };
const LEGEND_GAP = 20;
const BAR_H = 18;

function loadBlock(y: number, l: LoadBlock): string {
  const x = 24;
  const w = CARD_W - 48;
  const bx = x + 16;
  const bw = w - 32;
  const right = x + w - 16;
  const { yellow, orange, red } = l.scale;
  const bands: [number, number, string][] = [
    [0, yellow, C.greenDeep],
    [yellow, orange, C.amberDeep],
    [orange, red, C.orangeDeep],
    [red, 1, C.redDeep],
  ];
  const sy = y + 44 + BAR_H + 6;
  const scale = bands
    .filter(([a, b]) => b > a)
    .map(([a, b, c]) => `<rect x="${(bx + bw * a).toFixed(1)}" y="${sy}" width="${(bw * (b - a)).toFixed(1)}" height="4" fill="${c}" fill-opacity="0.7"/>`)
    .join('');
  // Legend: coloured swatch, grey label, value in the segment's colour; a note is grey text without a swatch.
  const ly = sy + 26;
  const texts = l.legend.items.map((it) => (it.kind === 'note' ? it.label : `${it.label} ${it.kw}`));
  // A note is all medium-weight text, narrower than the bold-number estimate.
  const widths = l.legend.items.map((it, i) => (it.kind === 'note' ? texts[i]!.length * 13 * 0.5 : 17 + textW(texts[i]!, 13, 600)));
  const natural = widths.reduce((a, b) => a + b, 0) + LEGEND_GAP * (widths.length - 1);
  const k = natural > 0 ? Math.min(1, bw / natural) : 1; // shrink the whole row rather than overflow
  const size = Math.floor(13 * k * 10) / 10;
  let lx = bx;
  const legend = l.legend.items
    .map((it, i) => {
      const at = lx;
      lx += (widths[i]! + LEGEND_GAP) * k;
      if (it.kind === 'note') return `<text x="${at.toFixed(1)}" y="${ly}" font-size="${size}" font-weight="500" fill="${C.muted}">${esc(texts[i]!)}</text>`;
      const color = SEGMENT_C[it.kind];
      return `<rect x="${at.toFixed(1)}" y="${ly - 10}" width="11" height="11" rx="3" fill="${color}"/>
<text x="${(at + 17 * k).toFixed(1)}" y="${ly}" font-size="${size}" font-weight="500" fill="${C.muted}">${esc(it.label)} <tspan font-weight="700" fill="${color}">${esc(it.kw)}</tspan></text>`;
    })
    .join('\n');
  let sx = bx;
  const bar = l.segments
    .map((sg) => {
      const at = sx;
      sx += bw * sg.frac;
      return sg.frac > 0 ? `<rect x="${at.toFixed(1)}" y="${y + 44}" width="${(bw * sg.frac).toFixed(1)}" height="${BAR_H}" fill="${SEGMENT_C[sg.kind]}"/>` : '';
    })
    .join('');
  const limitY = ly + 30;
  return `<rect x="${x}" y="${y}" width="${w}" height="${LOAD_H}" rx="16" fill="${C.tile}" stroke="${C.tileStroke}"/>
${icon('grid', bx, y + 13, ZONE[l.zone])}
<text x="${bx + 26}" y="${y + 27}" font-size="14" font-weight="500" fill="${C.muted}">${esc(l.label)}</text>
<text x="${right}" y="${y + 30}" text-anchor="end"><tspan font-size="24" font-weight="700" fill="${ZONE[l.zone]}">${esc(l.value)}</tspan><tspan dx="6" font-size="14" font-weight="500" fill="${C.muted}">/ ${esc(l.max)}</tspan></text>
<clipPath id="loadBar"><rect x="${bx}" y="${y + 44}" width="${bw}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
<g clip-path="url(#loadBar)">
  <rect x="${bx}" y="${y + 44}" width="${bw}" height="${BAR_H}" fill="rgba(255,255,255,0.08)"/>
  ${bar}
</g>
<clipPath id="zoneStrip"><rect x="${bx}" y="${sy}" width="${bw}" height="4" rx="2"/></clipPath>
<g clip-path="url(#zoneStrip)">${scale}</g>
${legend}
${
  l.legend.limit
    ? `<line x1="${bx}" y1="${limitY - 18}" x2="${right}" y2="${limitY - 18}" stroke="rgba(255,255,255,0.06)"/>
${icon('grid', bx - 2, limitY - 13, C.muted, 16)}
<text x="${bx + 20}" y="${limitY}" font-size="${fitFont(l.legend.limit, bw - 22, 13)}" font-weight="500" fill="${C.muted}">${esc(l.legend.limit)}</text>`
    : ''
}`;
}

// Inter has no colour emoji; the variation selector would show as a box.
export const plain = (s: string) => esc(s.replace(/\uFE0F/g, ''));

function scheduleTileHeight(s: ScheduleTile): number {
  return 70 + s.lines.length * 22;
}

function scheduleBlock(y: number, s: ScheduleTile): string {
  const x = 24;
  const w = CARD_W - 48;
  const h = scheduleTileHeight(s);
  const stroke = s.tone === 'red' ? C.redDeep : s.tone === 'amber' ? C.amberDeep : null;
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.tile}" stroke="${stroke ?? C.tileStroke}" ${stroke ? 'stroke-opacity="0.5"' : ''}/>`,
    icon('calendar', x + 16, y + 13, C.blue),
    `<text x="${x + 42}" y="${y + 27}" font-size="14" font-weight="500" fill="${C.muted}">${plain(s.label)}</text>`,
    `<text x="${x + 16}" y="${y + 56}" font-size="${fitFont(s.title, w - 32, 20)}" font-weight="700" fill="${TONE[s.tone === 'muted' ? 'plain' : s.tone]}">${plain(s.title)}</text>`,
  ];
  s.lines.forEach((l, i) => parts.push(`<text x="${x + 16}" y="${y + 80 + i * 22}" font-size="14" font-weight="500" fill="${TONE[l.tone]}">${plain(l.text)}</text>`));
  return parts.join('\n');
}

function banner(y: number, text: string): string {
  return `<rect x="24" y="${y}" width="${CARD_W - 48}" height="36" rx="12" fill="${C.amberDeep}" fill-opacity="0.14" stroke="${C.amberDeep}" stroke-opacity="0.4"/>
<text x="40" y="${y + 23}" font-size="14" font-weight="600" fill="${C.amber}">⚠ ${esc(text)}</text>`;
}

export function svgPanel(m: PanelModel): string {
  const parts: string[] = [];
  parts.push(pill(24, 24, m.status.label, m.status.kind));
  if (m.time) parts.push(`<text x="${CARD_W - 24}" y="45" text-anchor="end" font-size="14" font-weight="500" fill="${C.muted}">${m.time}</text>`);

  parts.push(ring(112, 166, 72, m.soc, m.socKwh));

  const tx = 222;
  if (m.flow) {
    parts.push(`<text x="${tx}" y="122" font-size="14" font-weight="500" fill="${C.muted}">${esc(m.flow.label)}</text>`);
    parts.push(`<text x="${tx}" y="154" font-size="30" font-weight="700" fill="${C.text}">${esc(m.flow.value)}</text>`);
  }
  if (m.eta) {
    // Labels like "Батареї 36% · при 1.42 кВт вистачить на" can be long: shrink to the card edge.
    parts.push(`<text x="${tx}" y="196" font-size="${Math.min(14, fitLabel(m.eta.label, CARD_W - 24 - tx))}" font-weight="500" fill="${C.muted}">${esc(m.eta.label)}</text>`);
    // Value + grey "(30 год)"; both shrink together if they don't fit to the card edge.
    const avail = CARD_W - 24 - tx;
    const size = m.eta.sub ? Math.min(30, avail / (m.eta.value.length * 0.6 + (m.eta.sub.length + 1) * 0.36)) : 30;
    const sub = m.eta.sub ? `<tspan dx="${(size * 0.25).toFixed(1)}" font-size="${(size * 0.6).toFixed(1)}" font-weight="600" fill="${C.muted}">${esc(m.eta.sub)}</tspan>` : '';
    parts.push(`<text x="${tx}" y="228" font-size="${size.toFixed(1)}" font-weight="700" fill="${m.eta.color ?? TONE[m.eta.tone]}">${esc(m.eta.value)}${sub}</text>`);
  }

  const gap = 12;
  const tw = (CARD_W - 48 - gap) / 2;
  const th = 86;
  let ty = 270;
  if (m.load) {
    parts.push(loadBlock(ty - 8, m.load));
    ty += LOAD_H + gap - 8;
  }
  if (m.schedule) {
    parts.push(scheduleBlock(ty - 8, m.schedule));
    ty += scheduleTileHeight(m.schedule) + gap;
  }
  m.tiles.forEach((t, i) => parts.push(tile(24 + (i % 2) * (tw + gap), ty + Math.floor(i / 2) * (th + gap), tw, th, t)));
  let h = ty + Math.ceil(m.tiles.length / 2) * (th + gap) + 12;
  if (m.stale) {
    parts.push(banner(h - 4, m.stale));
    h += 44;
  }
  return frame(h, parts.join('\n'));
}

export function statsRow(y: number, stats: Stat[]): string {
  const w = (CARD_W - 48) / stats.length;
  return stats
    .map(
      (s, i) => `<text x="${24 + i * w}" y="${y}" font-size="13" font-weight="500" fill="${C.muted}">${esc(s.label)}</text>
<text x="${24 + i * w}" y="${y + 32}" font-size="${fitFont(s.sub ? `${s.value} ${s.sub}` : s.value, w - 12, 26)}" font-weight="700" fill="${TONE[s.tone]}">${esc(s.value)}${s.sub ? ` <tspan fill="${C.muted}" font-weight="600">${esc(s.sub)}</tspan>` : ''}</text>`,
    )
    .join('\n');
}

const SEG_COLOR = { on: C.greenDeep, off: C.redDeep, unknown: C.unknown, future: C.future } as const;

export function svgDay(m: DayModel): string {
  const parts: string[] = [];
  parts.push(`<text x="24" y="50" font-size="24" font-weight="700" fill="${C.text}">${esc(m.title)}</text>`);
  let y = 50;
  if (m.subtitle) {
    parts.push(`<text x="24" y="76" font-size="13" font-weight="500" fill="${C.muted}">${esc(m.subtitle)}</text>`);
    y = 76;
  }
  y += 40;
  parts.push(statsRow(y, m.stats));
  y += 50;
  if (m.unknown) {
    parts.push(`<text x="24" y="${y + 8}" font-size="13" font-weight="500" fill="${C.muted}">${esc(m.unknown)}</text>`);
    y += 22;
  }

  // 24h timeline
  const bx = 24;
  const bw = CARD_W - 48;
  const by = y + 16;
  const bh = 40;
  parts.push(`<clipPath id="barclip"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="12"/></clipPath>`);
  parts.push(`<g clip-path="url(#barclip)"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${C.future}"/>`);
  for (const s of m.bar) {
    parts.push(`<rect x="${(bx + s.x0 * bw).toFixed(1)}" y="${by}" width="${Math.max(0.5, (s.x1 - s.x0) * bw).toFixed(1)}" height="${bh}" fill="${SEG_COLOR[s.state]}"/>`);
  }
  parts.push('</g>');
  for (const t of m.ticks) {
    const x = bx + t.x * bw;
    const anchor = t.x === 0 ? 'start' : t.x === 1 ? 'end' : 'middle';
    parts.push(`<text x="${x.toFixed(1)}" y="${by + bh + 20}" text-anchor="${anchor}" font-size="12" font-weight="500" fill="${C.dim}">${t.label}</text>`);
  }
  y = by + bh + 34;

  if (m.outages.length) {
    y += 14;
    parts.push(`<text x="24" y="${y}" font-size="13" font-weight="600" fill="${C.muted}">${esc(m.labels.outages)}</text>`);
    for (const line of m.outages) {
      y += 28;
      parts.push(`<circle cx="30" cy="${y - 5}" r="4" fill="${C.redDeep}"/><text x="44" y="${y}" font-size="16" font-weight="500" fill="${C.text}">${esc(line)}</text>`);
    }
    if (m.more) {
      y += 26;
      parts.push(`<text x="44" y="${y}" font-size="14" font-weight="500" fill="${C.muted}">${esc(m.labels.more)}</text>`);
    }
  }
  if (m.footer) {
    y += 34;
    parts.push(`<text x="24" y="${y}" font-size="14" font-weight="500" fill="${C.muted}">${esc(m.footer)}</text>`);
  }
  return frame(y + 28, parts.join('\n'));
}

export function svgPeriod(m: PeriodModel): string {
  const parts: string[] = [];
  parts.push(`<text x="24" y="50" font-size="24" font-weight="700" fill="${C.text}">${esc(m.title)}</text>`);
  let y = 90;
  parts.push(statsRow(y, m.stats));
  y += 66;

  const labelW = 70;
  const textCol = 130;
  const bx = 24 + labelW;
  const bw = CARD_W - 48 - labelW - textCol;
  for (const [i, r] of m.rows.entries()) {
    const ry = y + i * 38;
    parts.push(`<text x="24" y="${ry + 15}" font-size="15" font-weight="600" fill="${r.worst ? C.red : C.text}">${esc(r.label)}</text>`);
    parts.push(`<clipPath id="row${i}"><rect x="${bx}" y="${ry}" width="${bw}" height="20" rx="7"/></clipPath>`);
    parts.push(`<g clip-path="url(#row${i})"><rect x="${bx}" y="${ry}" width="${bw}" height="20" fill="${C.future}"/>`);
    let x = bx;
    for (const [w, color] of [
      [r.on, C.greenDeep],
      [r.off, C.redDeep],
      [r.unknown, C.unknown],
    ] as const) {
      if (w > 0) parts.push(`<rect x="${x.toFixed(1)}" y="${ry}" width="${(w * bw).toFixed(1)}" height="20" fill="${color}"/>`);
      x += w * bw;
    }
    parts.push('</g>');
    parts.push(`<text x="${CARD_W - 24}" y="${ry + 15}" text-anchor="end" font-size="15" font-weight="600" fill="${TONE[r.tone]}">${esc(r.text)}</text>`);
  }
  y += m.rows.length * 38 + 8;
  for (const n of m.notes) {
    y += 24;
    parts.push(`<text x="24" y="${y}" font-size="14" font-weight="500" fill="${C.muted}">${esc(n)}</text>`);
  }
  return frame(y + 28, parts.join('\n'));
}

export function svgMoney(m: MoneyModel): string {
  const parts: string[] = [];
  parts.push(`<text x="24" y="50" font-size="24" font-weight="700" fill="${C.text}">${esc(m.title)}</text>`);
  parts.push(`<text x="24" y="76" font-size="13" font-weight="500" fill="${C.muted}">${esc(m.labels.heading)}</text>`);

  parts.push(`<text x="24" y="116" font-size="14" font-weight="500" fill="${C.muted}">${esc(m.labels.spent)}</text>`);
  parts.push(`<text x="24" y="160" font-size="44" font-weight="800" fill="${C.text}">${esc(m.total)}</text>`);
  parts.push(`<text x="24" y="186" font-size="14" font-weight="500" fill="${C.muted}">${esc(m.totalSub)}</text>`);
  if (m.forecast) {
    parts.push(`<text x="${CARD_W - 24}" y="116" text-anchor="end" font-size="14" font-weight="500" fill="${C.muted}">${esc(m.labels.forecast)}</text>`);
    parts.push(`<text x="${CARD_W - 24}" y="152" text-anchor="end" font-size="28" font-weight="700" fill="${C.amber}">${esc(m.forecast)}</text>`);
  }

  const gap = 12;
  const tw = m.tiles.length > 1 ? (CARD_W - 48 - gap) / 2 : CARD_W - 48;
  const ty = 208;
  m.tiles.forEach((t, i) => parts.push(tile(24 + i * (tw + gap), ty, tw, 86, t)));

  // Daily cost bars: night at the bottom, day on top.
  let y = ty + 86 + 36;
  parts.push(`<text x="24" y="${y}" font-size="13" font-weight="600" fill="${C.muted}">${esc(m.labels.byDay)}</text>`);
  parts.push(`<circle cx="${CARD_W - 150}" cy="${y - 4}" r="5" fill="${C.amberDeep}"/><text x="${CARD_W - 140}" y="${y}" font-size="12" font-weight="500" fill="${C.muted}">${esc(m.labels.day)}</text>`);
  parts.push(`<circle cx="${CARD_W - 88}" cy="${y - 4}" r="5" fill="${C.violet}"/><text x="${CARD_W - 78}" y="${y}" font-size="12" font-weight="500" fill="${C.muted}">${esc(m.labels.night)}</text>`);
  const top = y + 14;
  const ch = 96;
  const slot = (CARD_W - 48) / m.bars.length;
  const bw = Math.max(3, slot * 0.64);
  for (const [i, b] of m.bars.entries()) {
    const x = 24 + i * slot + (slot - bw) / 2;
    const nh = b.night * ch;
    const dh = b.day * ch;
    const base = top + ch;
    if (nh + dh < 1) parts.push(`<rect x="${x.toFixed(1)}" y="${base - 2}" width="${bw.toFixed(1)}" height="2" rx="1" fill="${C.future}"/>`);
    if (nh > 0) parts.push(`<rect x="${x.toFixed(1)}" y="${(base - nh).toFixed(1)}" width="${bw.toFixed(1)}" height="${nh.toFixed(1)}" rx="2" fill="${C.violet}"/>`);
    if (dh > 0) parts.push(`<rect x="${x.toFixed(1)}" y="${(base - nh - dh).toFixed(1)}" width="${bw.toFixed(1)}" height="${dh.toFixed(1)}" rx="2" fill="${C.amberDeep}"/>`);
    if (b.today) parts.push(`<rect x="${(x - 2).toFixed(1)}" y="${top - 4}" width="${(bw + 4).toFixed(1)}" height="${ch + 6}" rx="4" fill="none" stroke="${C.muted}" stroke-opacity="0.5" stroke-dasharray="3 3"/>`);
    if (b.label) parts.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${base + 20}" text-anchor="middle" font-size="12" font-weight="500" fill="${C.dim}">${b.label}</text>`);
  }
  y = top + ch + 60;
  parts.push(statsRow(y, m.stats));
  y += 40;
  for (const n of m.notes) {
    y += 26;
    parts.push(`<text x="24" y="${y}" font-size="15" font-weight="500" fill="${C.muted}">${esc(n)}</text>`);
  }
  return frame(y + 28, parts.join('\n'));
}

const SCHED_DAY_H = 128;

export function svgSchedule(m: ScheduleCardModel): string {
  const parts: string[] = [];
  parts.push(`<text x="24" y="52" font-size="26" font-weight="700" fill="${C.text}">${plain(m.title)}</text>`);
  parts.push(`<text x="24" y="80" font-size="14" font-weight="500" fill="${C.muted}">${plain(m.updated)}</text>`);
  let y = 100;
  if (m.stale) {
    parts.push(`<text x="24" y="${y}" font-size="14" font-weight="500" fill="${C.amber}">${plain(m.stale)}</text>`);
    y += 14;
  }
  y += 8;
  const x = 24;
  const w = CARD_W - 48;
  const bx = x + 16;
  const bw = w - 32;
  m.days.forEach((d, i) => {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${SCHED_DAY_H}" rx="16" fill="${C.tile}" stroke="${C.tileStroke}"/>`);
    parts.push(`<text x="${bx}" y="${y + 30}" font-size="16" font-weight="700" fill="${C.text}">${plain(d.title)}</text>`);
    parts.push(`<text x="${x + w - 16}" y="${y + 30}" text-anchor="end" font-size="14" font-weight="600" fill="${TONE[d.totalTone]}">${plain(d.total)}</text>`);
    const by = y + 44;
    const clip = `schedBar${i}`;
    parts.push(`<clipPath id="${clip}"><rect x="${bx}" y="${by}" width="${bw}" height="16" rx="8"/></clipPath><g clip-path="url(#${clip})">`);
    parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="16" fill="${d.published ? C.greenDeep : C.unknown}"/>`);
    for (const b of d.bar) parts.push(`<rect x="${(bx + bw * b.x0).toFixed(1)}" y="${by}" width="${(bw * (b.x1 - b.x0)).toFixed(1)}" height="16" fill="${C.redDeep}"/>`);
    parts.push('</g>');
    if (d.nowX !== null) parts.push(`<rect x="${(bx + bw * d.nowX - 1).toFixed(1)}" y="${by - 5}" width="2" height="26" rx="1" fill="${C.text}"/>`);
    for (const t of d.ticks) {
      const anchor = t.x === 0 ? 'start' : t.x === 1 ? 'end' : 'middle';
      parts.push(`<text x="${(bx + bw * t.x).toFixed(1)}" y="${by + 36}" text-anchor="${anchor}" font-size="12" font-weight="500" fill="${C.dim}">${t.label}</text>`);
    }
    if (d.spans) parts.push(`<text x="${bx}" y="${y + 110}" font-size="${fitFont(d.spans, bw, 15)}" font-weight="600" fill="${C.text}">${plain(d.spans)}</text>`);
    y += SCHED_DAY_H + 12;
  });
  parts.push(scheduleBlock(y, m.status));
  y += scheduleTileHeight(m.status) + 24;
  return frame(y, parts.join('\n'));
}

const BAT_TILE_H = 112;
const BAT_CHART_H = 120;

export function svgBattery(m: BatteryCardModel): string {
  const parts: string[] = [];
  parts.push(`<text x="24" y="52" font-size="26" font-weight="700" fill="${C.text}">${plain(m.title)}</text>`);
  parts.push(`<text x="24" y="80" font-size="14" font-weight="500" fill="${C.muted}">${plain(m.subtitle)}</text>`);
  const gap = 12;
  const tw = (CARD_W - 48 - gap) / 2;
  const top = 100;
  m.tiles.forEach((t, i) => {
    const x = 24 + (i % 2) * (tw + gap);
    const y = top + Math.floor(i / 2) * (BAT_TILE_H + gap);
    parts.push(`<rect x="${x}" y="${y}" width="${tw}" height="${BAT_TILE_H}" rx="16" fill="${C.tile}" stroke="${C.tileStroke}"/>`);
    parts.push(`<text x="${x + 16}" y="${y + 28}" font-size="14" font-weight="500" fill="${C.muted}">${plain(t.label)}</text>`);
    parts.push(`<text x="${x + 16}" y="${y + 64}" font-size="${fitFont(t.value, tw - 32, 26)}" font-weight="700" fill="${TONE[t.tone]}">${plain(t.value)}</text>`);
    // Notes can be long in some languages: shrink rather than overflow the tile.
    const note = t.note;
    const size = Math.min(13, Math.floor(((tw - 32) / (note.length * 0.56)) * 10) / 10);
    parts.push(`<text x="${x + 16}" y="${y + 92}" font-size="${size}" font-weight="500" fill="${C.muted}">${plain(note)}</text>`);
  });
  let y = top + 2 * (BAT_TILE_H + gap) + 20;
  parts.push(`<text x="24" y="${y}" font-size="13" font-weight="600" fill="${C.muted}">${plain(m.chart)}</text>`);
  y += 14;
  const cx = 24;
  const cw = CARD_W - 48 - 40; // room for the threshold labels
  const base = y + BAT_CHART_H;
  const slot = cw * m.slotW;
  for (const b of m.bars) {
    const h = Math.max(2, b.h * BAT_CHART_H);
    const color = b.tone === 'red' ? C.redDeep : b.tone === 'amber' ? C.amberDeep : b.tone === 'muted' ? C.unknown : C.greenDeep;
    parts.push(`<rect x="${(cx + b.x * cw + 1).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${Math.max(2, slot - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"/>`);
  }
  for (const mk of m.marks) {
    const my = (base - mk.y * BAT_CHART_H).toFixed(1);
    parts.push(`<line x1="${cx}" y1="${my}" x2="${cx + cw}" y2="${my}" stroke="${C.muted}" stroke-opacity="0.5" stroke-dasharray="4 4"/>`);
    parts.push(`<text x="${CARD_W - 24}" y="${Number(my) + 4}" text-anchor="end" font-size="11" font-weight="500" fill="${C.muted}">${mk.label}</text>`);
  }
  return frame(base + 28, parts.join('\n'));
}
