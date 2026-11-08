// Owner-editable settings: defaults come from .env, changes are stored in the DB and applied live.
import type { Config } from './config.js';
import type { Dict } from './i18n/index.js';

export type Tunable =
  | 'tariffDay'
  | 'tariffNight'
  | 'tariffNightFrom'
  | 'tariffNightTo'
  | 'batteryThresholds'
  | 'batteryReservePct'
  | 'batteryTempMaxC'
  | 'inverterTempMaxC'
  | 'quietFrom'
  | 'quietTo'
  | 'cloudDownAfterMin'
  | 'gridLoadMaxKw'
  | 'batteryLoadMaxKw'
  | 'gridChargeA';

export type Overrides = Partial<Pick<Config, Tunable>>;

export type SectionId = keyof Dict['cfg']['sections'];
type Unit = 'uah' | 'pct' | 'c' | 'min' | 'kw' | 'a';

// Texts (labels, hints, units) come from the dictionary: t.cfg.fields[key], t.cfg.sections[id].
export interface Field {
  key: Tunable;
  section: SectionId;
  kind: 'choice' | 'multi' | 'price';
  options?: number[];
  unit?: Unit;
  hour?: boolean; // render as HH:00
  nullable?: boolean; // price fields that may be switched off
}

export const SECTIONS: SectionId[] = ['tariff', 'battery', 'temp', 'load', 'quiet', 'service'];

const HOURS_EVENING = [20, 21, 22, 23, 0];
const HOURS_MORNING = [5, 6, 7, 8, 9];

export const FIELDS: Field[] = [
  { key: 'tariffDay', section: 'tariff', kind: 'price', unit: 'uah', options: [4.32] },
  { key: 'tariffNight', section: 'tariff', kind: 'price', unit: 'uah', options: [2.16], nullable: true },
  { key: 'tariffNightFrom', section: 'tariff', kind: 'choice', options: HOURS_EVENING, hour: true },
  { key: 'tariffNightTo', section: 'tariff', kind: 'choice', options: HOURS_MORNING, hour: true },
  { key: 'batteryThresholds', section: 'battery', kind: 'multi', options: [80, 70, 60, 50, 40, 30, 20, 15, 10, 5], unit: 'pct' },
  { key: 'batteryReservePct', section: 'battery', kind: 'choice', options: [0, 5, 10, 15, 20, 30], unit: 'pct' },
  { key: 'batteryTempMaxC', section: 'temp', kind: 'choice', options: [35, 40, 45, 50, 55], unit: 'c' },
  { key: 'inverterTempMaxC', section: 'temp', kind: 'choice', options: [60, 65, 70, 75, 80, 85], unit: 'c' },
  { key: 'gridLoadMaxKw', section: 'load', kind: 'choice', options: [7, 7.5, 8, 8.5, 9, 9.5], unit: 'kw' },
  { key: 'batteryLoadMaxKw', section: 'load', kind: 'choice', options: [6, 6.5, 7, 7.5, 8], unit: 'kw' },
  { key: 'gridChargeA', section: 'load', kind: 'choice', options: [40, 50, 60, 70, 80, 90, 100, 120, 150], unit: 'a' },
  { key: 'quietFrom', section: 'quiet', kind: 'choice', options: HOURS_EVENING, hour: true },
  { key: 'quietTo', section: 'quiet', kind: 'choice', options: HOURS_MORNING, hour: true },
  { key: 'cloudDownAfterMin', section: 'service', kind: 'choice', options: [5, 10, 15, 30, 60], unit: 'min' },
];

/** Unit suffix as shown after a value; % and °C stick to the number. */
export function unitText(f: Field, t: Dict): string {
  switch (f.unit) {
    case 'uah':
      return ` ${t.units.uahPerKwh}`;
    case 'pct':
      return '%';
    case 'c':
      return '°C';
    case 'min':
      return ` ${t.units.min}`;
    case 'kw':
      return ` ${t.units.kw}`;
    case 'a':
      return ` ${t.units.a}`;
    default:
      return '';
  }
}

export const fieldTexts = (f: Field, t: Dict): { label: string; hint?: string; nullLabel?: string } => t.cfg.fields[f.key];

const field = (k: string) => FIELDS.find((f) => f.key === k);

export function fieldText(f: Field, v: unknown, t: Dict): string {
  if (v === null) return fieldTexts(f, t).nullLabel ?? '—';
  if (Array.isArray(v)) return v.length ? `${v.join(' / ')}${unitText(f, t)}` : t.common.off;
  if (f.hour) return `${String(v).padStart(2, '0')}:00`;
  if (f.kind === 'price') return `${Number(v).toFixed(2)}${unitText(f, t)}`;
  return `${v}${unitText(f, t)}`;
}

/** Accepts "4,32", "4.32 ₴"; 0 < price < 100. */
export function parsePrice(text: string): number | null {
  const m = text.replace(',', '.').match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Math.round(Number(m[0]) * 100) / 100;
  return n > 0 && n < 100 ? n : null;
}

function valid(f: Field, v: unknown): unknown {
  if (f.kind === 'price') {
    if (v === null) return f.nullable ? null : undefined;
    return typeof v === 'number' && v > 0 && v < 100 ? v : undefined;
  }
  if (f.kind === 'multi') {
    if (!Array.isArray(v) || !v.every((x) => f.options!.includes(x))) return undefined;
    return [...new Set(v as number[])].sort((a, b) => b - a);
  }
  return typeof v === 'number' && f.options!.includes(v) ? v : undefined;
}

export function applyOverrides(base: Config, o: Overrides): Config {
  const out = { ...base };
  for (const [k, v] of Object.entries(o)) {
    const f = field(k);
    if (!f) continue;
    const ok = valid(f, v);
    if (ok !== undefined) (out as Record<string, unknown>)[k] = ok;
  }
  return out;
}

export function validValue(key: Tunable, v: unknown): boolean {
  const f = field(key);
  return !!f && valid(f, v) !== undefined;
}

/** Live settings: mutates the shared config object so every module sees changes at once. */
export class SettingsStore {
  private overrides: Overrides;

  constructor(
    private base: Config,
    private live: Config,
    private load: () => Overrides | null,
    private save: (o: Overrides) => void,
  ) {
    this.overrides = load() ?? {};
    Object.assign(this.live, applyOverrides(base, this.overrides));
  }

  get<K extends Tunable>(key: K): Config[K] {
    return this.live[key];
  }

  defaultOf<K extends Tunable>(key: K): Config[K] {
    return this.base[key];
  }

  set<K extends Tunable>(key: K, value: Config[K]): boolean {
    if (!validValue(key, value)) return false;
    this.overrides = { ...this.overrides, [key]: value };
    this.apply();
    return true;
  }

  reset(key: Tunable): void {
    const { [key]: _, ...rest } = this.overrides;
    this.overrides = rest;
    this.apply();
  }

  private apply(): void {
    this.save(this.overrides);
    Object.assign(this.live, applyOverrides(this.base, this.overrides));
  }
}
