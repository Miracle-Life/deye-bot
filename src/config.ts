import { IANAZone } from 'luxon';

export interface Config {
  deyeSource: 'official' | 'unofficial';
  deyeBaseUrl: string;
  deyeAppId: string;
  deyeAppSecret: string;
  deyeEmail: string;
  deyePassword: string;
  deyeStationId: string | null;
  deyeDeviceSn: string | null;
  telegramToken: string;
  adminTelegramId: number;
  pollIntervalSec: number;
  staleAfterMin: number;
  batteryReservePct: number;
  batteryCapacityKwh: number;
  batteryThresholds: number[];
  gridOffVolts: number;
  gridOkVolts: number;
  batteryTempMaxC: number;
  inverterTempMaxC: number;
  cloudDownAfterMin: number;
  gridLoadMaxKw: number; // admin alert and red zone from this grid draw
  batteryLoadMaxKw: number; // alert to everyone and red zone from this house draw during an outage
  gridChargeA: number; // inverter Batt set2 → Grid Charge, A (not in the cloud API)
  batteryRatedCycles: number; // rated cycle life for the wear estimate
  tariffDay: number; // ₴/kWh
  tariffNight: number | null; // null = single-zone
  tariffNightFrom: number; // hour
  tariffNightTo: number;
  quietFrom: number; // night mode hours
  quietTo: number;
  watchdogUrl: string | null; // Cloudflare watchdog worker; off when empty
  watchdogSecret: string | null;
  dbPath: string;
  timezone: string;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config: ${key} must be a number`);
  return n;
}

function str(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

export function loadConfig(env: Env): Config {
  const source = (str(env, 'DEYE_SOURCE') ?? 'official') as Config['deyeSource'];
  if (source !== 'official' && source !== 'unofficial') {
    throw new Error('Config: DEYE_SOURCE must be "official" or "unofficial"');
  }

  const required = ['TELEGRAM_TOKEN', 'ADMIN_TELEGRAM_ID', 'DEYE_EMAIL', 'DEYE_PASSWORD'];
  if (source === 'official') required.push('DEYE_APP_ID', 'DEYE_APP_SECRET');
  const missing = required.filter((k) => !str(env, k));
  if (missing.length) throw new Error(`Config: missing required env: ${missing.join(', ')}`);

  const thresholds = (str(env, 'BATTERY_THRESHOLDS') ?? '50,30,20,10')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);

  const timezone = str(env, 'TZ_NAME') ?? 'Europe/Kyiv';
  if (!IANAZone.isValidZone(timezone)) throw new Error('Config: TZ_NAME must be an IANA zone, e.g. Europe/Kyiv');
  const pollIntervalSec = num(env, 'POLL_INTERVAL_SEC', 60);
  // Above 10 min the watchdog would take normal pauses for a stalled bot.
  if (pollIntervalSec < 10 || pollIntervalSec > 600) throw new Error('Config: POLL_INTERVAL_SEC must be 10..600');
  const batteryRatedCycles = num(env, 'BATTERY_RATED_CYCLES', 6000);
  if (batteryRatedCycles < 500 || batteryRatedCycles > 20000) throw new Error('Config: BATTERY_RATED_CYCLES must be 500..20000');
  const gridChargeA = num(env, 'GRID_CHARGE_A', 80);
  if (gridChargeA < 10 || gridChargeA > 300) throw new Error('Config: GRID_CHARGE_A must be 10..300');
  const batteryLoadMaxKw = num(env, 'BATTERY_LOAD_MAX_KW', 7);
  if (batteryLoadMaxKw < 1 || batteryLoadMaxKw > 20) throw new Error('Config: BATTERY_LOAD_MAX_KW must be 1..20');
  const watchdogUrl = str(env, 'WATCHDOG_URL');
  // The beat carries the shared secret in a header.
  if (watchdogUrl && !watchdogUrl.startsWith('https://')) throw new Error('Config: WATCHDOG_URL must be https://');

  return {
    deyeSource: source,
    deyeBaseUrl: str(env, 'DEYE_BASE_URL') ?? 'https://eu1-developer.deyecloud.com/v1.0',
    deyeAppId: str(env, 'DEYE_APP_ID') ?? '',
    deyeAppSecret: str(env, 'DEYE_APP_SECRET') ?? '',
    deyeEmail: str(env, 'DEYE_EMAIL')!,
    deyePassword: str(env, 'DEYE_PASSWORD')!,
    deyeStationId: str(env, 'DEYE_STATION_ID'),
    deyeDeviceSn: str(env, 'DEYE_DEVICE_SN'),
    telegramToken: str(env, 'TELEGRAM_TOKEN')!,
    adminTelegramId: num(env, 'ADMIN_TELEGRAM_ID', 0),
    pollIntervalSec,
    staleAfterMin: num(env, 'STALE_AFTER_MIN', 15),
    batteryReservePct: num(env, 'BATTERY_RESERVE_PCT', 10),
    batteryCapacityKwh: num(env, 'BATTERY_CAPACITY_KWH', 24),
    batteryThresholds: thresholds,
    gridOffVolts: num(env, 'GRID_OFF_VOLTS', 50),
    gridOkVolts: num(env, 'GRID_OK_VOLTS', 180),
    batteryTempMaxC: num(env, 'BATTERY_TEMP_MAX_C', 45),
    inverterTempMaxC: num(env, 'INVERTER_TEMP_MAX_C', 70),
    cloudDownAfterMin: num(env, 'CLOUD_DOWN_AFTER_MIN', 10),
    gridLoadMaxKw: num(env, 'GRID_LOAD_MAX_KW', 8),
    batteryLoadMaxKw,
    gridChargeA,
    batteryRatedCycles,
    tariffDay: num(env, 'TARIFF_DAY', 4.32),
    tariffNight: /^(none|off|0)$/i.test(env.TARIFF_NIGHT ?? '') ? null : num(env, 'TARIFF_NIGHT', 2.16),
    tariffNightFrom: num(env, 'TARIFF_NIGHT_FROM', 23),
    tariffNightTo: num(env, 'TARIFF_NIGHT_TO', 7),
    quietFrom: num(env, 'QUIET_FROM', 23),
    quietTo: num(env, 'QUIET_TO', 7),
    watchdogUrl,
    watchdogSecret: str(env, 'WATCHDOG_SECRET'),
    dbPath: str(env, 'DB_PATH') ?? './data/deye.db',
    timezone,
  };
}
