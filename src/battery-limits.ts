// Inverter battery settings (charge/discharge current): read rarely, last good value kept.
import type { BatteryLimits, DataSource } from './deye/types.js';
import { errInfo, log } from './log.js';

const EVERY_MS = 6 * 60 * 60_000;
const RETRY_MS = 10 * 60_000; // until the first successful read

export class BatteryLimitsService {
  private value: BatteryLimits | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private src: DataSource) {}

  start(): void {
    if (!this.src.batteryLimits) return;
    void this.refresh();
    this.timers.push(setInterval(() => void this.refresh(), EVERY_MS));
    this.timers.push(setInterval(() => this.value === null && void this.refresh(), RETRY_MS));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  get(): BatteryLimits | null {
    return this.value;
  }

  private async refresh(): Promise<void> {
    try {
      this.value = await this.src.batteryLimits!();
    } catch (e) {
      // warn, not error: errors page the admin, and the panel just omits the limits.
      log.warn('battery limits read failed', errInfo(e));
    }
  }
}
