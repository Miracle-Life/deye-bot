// Grid purchase split into day/night tariff zones from Deye's daily energy counters.
import { DateTime } from 'luxon';

export interface EnergyFrame {
  ts: number;
  purchased: number | null; // kWh since local midnight (DailyEnergyPurchased)
  consumption: number | null;
  charge: number | null;
  discharge: number | null;
  pv: number | null;
}

/** One local day reduced to what any tariff split needs: the purchase counter at each hour boundary. */
export interface EnergyDayRaw {
  date: string; // local ISO date
  purchasedAtHour: number[]; // [h] = kWh bought before hour h (0..23); [24] = whole day
  consumption: number;
  charge: number;
  discharge: number;
  pv: number;
}

export interface EnergyDay {
  date: string;
  dayKwh: number; // bought from the grid at the day rate
  nightKwh: number;
  consumption: number;
  charge: number;
  discharge: number;
  pv: number;
}

export interface Tariff {
  dayPrice: number; // ₴/kWh
  nightPrice: number | null; // null = single-zone tariff
  nightFrom: number; // hour the night rate starts (e.g. 23)
  nightTo: number; // hour it ends (e.g. 7)
}

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Highest counter value seen up to `t` (counters only grow; max shrugs off glitches). */
function valueAt(frames: EnergyFrame[], key: Counter, t = Infinity): number {
  let v = 0;
  for (const f of frames) if (f.ts <= t && f[key] !== null && f[key]! > v) v = f[key]!;
  return v;
}

type Counter = keyof Omit<EnergyFrame, 'ts'>;
const RESET_WINDOW_MS = 30 * 60_000;

/**
 * The logger may reset its daily counters a few minutes late: early frames still carrying
 * yesterday's total (higher than a later value) are dropped. Later glitches are left to `valueAt`.
 */
function dropLateReset(frames: EnergyFrame[], key: Counter, dayStart: number): EnergyFrame[] {
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  return sorted.filter((f, i) => {
    const v = f[key];
    if (v === null || f.ts >= dayStart + RESET_WINDOW_MS) return true;
    return !sorted.slice(i + 1).some((g) => g[key] !== null && g[key]! < v);
  });
}

export function summarizeFrames(all: EnergyFrame[], dateIso: string, zone: string): EnergyDayRaw {
  const day = DateTime.fromISO(dateIso, { zone });
  const start = day.startOf('day').toMillis();
  const by = (key: Counter) => dropLateReset(all, key, start);
  const frames = by('purchased');
  const purchasedAtHour = Array.from({ length: 24 }, (_, h) => r2(valueAt(frames, 'purchased', day.set({ hour: h }).toMillis())));
  purchasedAtHour.push(r2(valueAt(frames, 'purchased')));
  return {
    date: dateIso,
    purchasedAtHour,
    consumption: r2(valueAt(by('consumption'), 'consumption')),
    charge: r2(valueAt(by('charge'), 'charge')),
    discharge: r2(valueAt(by('discharge'), 'discharge')),
    pv: r2(valueAt(by('pv'), 'pv')),
  };
}

/** Night = before `nightTo` plus after `nightFrom` (the night wraps midnight). */
export function splitDay(raw: EnergyDayRaw, t: Tariff): EnergyDay {
  const at = (h: number) => raw.purchasedAtHour[Math.max(0, Math.min(24, h))] ?? 0;
  const total = at(24);
  const nightKwh = t.nightPrice === null ? 0 : t.nightFrom > t.nightTo ? at(t.nightTo) + (total - at(t.nightFrom)) : at(t.nightTo) - at(t.nightFrom);
  const { purchasedAtHour: _, ...rest } = raw;
  return { ...rest, dayKwh: r2(total - nightKwh), nightKwh: r2(nightKwh) };
}

export const dayCost = (d: EnergyDay, t: Tariff) => d.dayKwh * t.dayPrice + d.nightKwh * (t.nightPrice ?? t.dayPrice);

export interface MonthSummary {
  cost: number;
  dayKwh: number;
  nightKwh: number;
  dayCost: number;
  nightCost: number;
  consumption: number;
  charge: number;
  discharge: number;
  pv: number;
  savedByNight: number; // vs buying the night kWh at the day rate
  forecast: number | null; // whole-month cost at the current pace (current month only)
  perDay: { date: string; dayCost: number; nightCost: number }[];
}

export function monthSummary(days: EnergyDay[], t: Tariff, monthIso: string, nowMs: number, zone: string, dataFromMs: number | null): MonthSummary {
  const night = t.nightPrice ?? t.dayPrice;
  const sum = (k: keyof Omit<EnergyDay, 'date'>) => days.reduce((a, d) => a + d[k], 0);
  const dayKwh = sum('dayKwh');
  const nightKwh = sum('nightKwh');
  const cost = dayKwh * t.dayPrice + nightKwh * night;

  const start = DateTime.fromISO(`${monthIso}-01`, { zone });
  const end = start.plus({ months: 1 });
  let forecast: number | null = null;
  if (nowMs >= start.toMillis() && nowMs < end.toMillis()) {
    const from = Math.max(start.toMillis(), dataFromMs ?? start.toMillis());
    const elapsedDays = (nowMs - from) / DAY;
    if (elapsedDays >= 1) forecast = (cost / elapsedDays) * end.diff(start, 'days').days;
  }
  return {
    cost,
    dayKwh,
    nightKwh,
    dayCost: dayKwh * t.dayPrice,
    nightCost: nightKwh * night,
    consumption: sum('consumption'),
    charge: sum('charge'),
    discharge: sum('discharge'),
    pv: sum('pv'),
    savedByNight: nightKwh * (t.dayPrice - night),
    forecast,
    perDay: days.map((d) => ({ date: d.date, dayCost: d.dayKwh * t.dayPrice, nightCost: d.nightKwh * night })),
  };
}
