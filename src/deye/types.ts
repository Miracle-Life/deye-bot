import type { EnergyFrame } from '../domain/energy.js';
import type { DeyeAlert } from '../domain/watch.js';

export interface Reading {
  ts: number; // data time from Deye, epoch ms (NOT poll time)
  soc: number | null; // %
  batteryPowerW: number | null; // >0 charging, <0 discharging
  gridVoltages: (number | null)[]; // [L1, L2, L3]
  gridStatusOn: boolean | null; // explicit flag if the API has one
  gridPowerW: number | null;
  loadPowerW: number | null; // "Нагрузка"
  upsLoadPowerW: number | null; // "UPS-Load"
  pvPowerW: number | null;
  batteryVoltage: number | null;
  batteryTempC: number | null;
  inverterTempC: number | null;
  phaseLoadW: (number | null)[];
  batteryCapacityKwh: number | null;
  ratedPowerW: number | null; // inverter rating
  dischargeTotalKwh: number | null; // lifetime battery counters (live readings only)
  chargeTotalKwh: number | null;
}

/** Inverter battery settings, A; null when not reported. */
export interface BatteryLimits {
  chargeA: number | null;
  dischargeA: number | null;
}

export interface Interval {
  start: number; // epoch ms
  end: number | null; // null = ongoing
}

export interface DataSource {
  latest(): Promise<Reading>;
  history(fromMs: number, toMs: number): Promise<Reading[]>; // [] if unsupported
  alerts?(fromMs: number, toMs: number): Promise<DeyeAlert[]>;
  energyFrames?(dateIso: string): Promise<EnergyFrame[]>;
  batteryLimits?(): Promise<BatteryLimits>; // inverter settings, not telemetry
}

export function emptyReading(ts: number): Reading {
  return {
    ts,
    soc: null,
    batteryPowerW: null,
    gridVoltages: [null, null, null],
    gridStatusOn: null,
    gridPowerW: null,
    loadPowerW: null,
    upsLoadPowerW: null,
    pvPowerW: null,
    batteryVoltage: null,
    batteryTempC: null,
    inverterTempC: null,
    phaseLoadW: [],
    batteryCapacityKwh: null,
    ratedPowerW: null,
    dischargeTotalKwh: null,
    chargeTotalKwh: null,
  };
}
