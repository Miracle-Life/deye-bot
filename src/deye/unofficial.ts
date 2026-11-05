import type { Config } from '../config.js';
import type { DataSource, Reading } from './types.js';

// Fallback via the Deye Cloud app API — implemented only if the official OpenAPI can't be used (plan Task 3).
export class UnofficialDeyeSource implements DataSource {
  constructor(_cfg: Config) {}

  async latest(): Promise<Reading> {
    throw new Error('Unofficial Deye source is not implemented yet (plan Task 3)');
  }

  async history(): Promise<Reading[]> {
    return [];
  }
}
