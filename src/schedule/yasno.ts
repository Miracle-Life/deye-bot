// The only place that knows the YASNO API: URLs, ids, response shapes, validation.
// If YASNO changes something, fix it here; everything else uses ./model.ts.
import { DateTime } from 'luxon';
import type { DayStatus, Schedule, ScheduleDay, Span } from './model.js';

const BASE = 'https://app.yasno.ua/api/blackout-service/public/shutdowns';
const REGION = 25; // Kyiv
const DSO = 902; // DTEK Kyiv Grids
const ZONE = 'Europe/Kyiv';
const TIMEOUT_MS = 15_000;
const DAY_MIN = 1440;

const STATUS: Record<string, DayStatus> = { ScheduleApplies: 'applies', WaitingForSchedule: 'waiting', EmergencyShutdowns: 'emergency' };
const POWER = 'NotPlanned';
const OUTAGE = 'Definite';

export class YasnoFormatError extends Error {}

const fail = (why: string): never => {
  throw new YasnoFormatError(`YASNO response: ${why}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isMin = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DAY_MIN;

function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

// Slot minutes are wall-clock times (600 = 10:00), not elapsed time: on DST days these differ.
function wallClock(midnight: DateTime, min: number): number {
  return min === DAY_MIN ? midnight.plus({ days: 1 }).toMillis() : midnight.set({ hour: Math.floor(min / 60), minute: min % 60 }).toMillis();
}

function parseDay(v: unknown, unknown: Set<string>): ScheduleDay {
  if (!isObj(v) || typeof v.date !== 'string' || !Array.isArray(v.slots)) fail('day without date/slots');
  const d = v as { date: string; status?: unknown; slots: unknown[] };
  const midnight = DateTime.fromISO(d.date, { setZone: true }).setZone(ZONE).startOf('day');
  if (!midnight.isValid) fail(`bad date ${d.date}`);
  const spans: Span[] = [];
  for (const s of d.slots) {
    if (!isObj(s) || !isMin(s.start) || !isMin(s.end) || s.end < s.start || typeof s.type !== 'string') fail('bad slot');
    const slot = s as { start: number; end: number; type: string };
    if (slot.type === POWER) continue;
    if (slot.type !== OUTAGE) unknown.add(slot.type); // conservative: never hide a possible outage
    const span = { start: wallClock(midnight, slot.start), end: wallClock(midnight, slot.end) };
    if (span.end > span.start) spans.push(span); // a slot inside the skipped spring-forward hour is empty
  }
  return { date: midnight.toISODate()!, status: STATUS[String(d.status)] ?? 'unknown', outages: mergeSpans(spans) };
}

export function parsePlanned(json: unknown, group: string, fetchedAt: number): Schedule {
  if (!isObj(json)) fail('not an object');
  const g = (json as Record<string, unknown>)[group];
  if (!isObj(g)) fail(`no group ${group}`);
  const grp = g as Record<string, unknown>;
  const unknown = new Set<string>();
  const days = [parseDay(grp.today, unknown), parseDay(grp.tomorrow, unknown)];
  const updated = typeof grp.updatedOn === 'string' ? Date.parse(grp.updatedOn) : NaN;
  return { group, days, updatedAt: Number.isFinite(updated) ? updated : null, fetchedAt, unknownTypes: [...unknown] };
}

export function parseGroup(json: unknown): string {
  const j = json as { group?: unknown; subgroup?: unknown } | null;
  if (!j || !Number.isInteger(j.group) || !Number.isInteger(j.subgroup)) fail('bad group');
  return `${j!.group}.${j!.subgroup}`;
}

export function parseOptions(json: unknown): { id: number; name: string }[] {
  if (!Array.isArray(json)) fail('options not an array');
  return (json as unknown[]).map((o) => {
    if (!isObj(o) || !Number.isInteger(o.id) || typeof o.value !== 'string') fail('bad option');
    return { id: (o as { id: number }).id, name: (o as { value: string }).value };
  });
}

export class YasnoClient {
  constructor(private fetchFn: typeof fetch = fetch) {}

  streets(query: string) {
    return this.get('/addresses/v2/streets', { query }).then(parseOptions);
  }

  houses(streetId: number, query: string) {
    return this.get('/addresses/v2/houses', { streetId, query }).then(parseOptions);
  }

  group(streetId: number, houseId: number): Promise<string> {
    return this.get('/addresses/v2/group', { streetId, houseId }).then(parseGroup);
  }

  async planned(group: string): Promise<Schedule> {
    return parsePlanned(await this.get(`/regions/${REGION}/dsos/${DSO}/planned-outages`), group, Date.now());
  }

  private async get(path: string, params?: Record<string, string | number>): Promise<unknown> {
    const qs = params ? `?${new URLSearchParams({ regionId: String(REGION), dsoId: String(DSO), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })}` : '';
    const res = await this.fetchFn(BASE + path + qs, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`YASNO ${path}: HTTP ${res.status}`);
    return res.json().catch(() => fail(`${path}: not JSON`));
  }
}
