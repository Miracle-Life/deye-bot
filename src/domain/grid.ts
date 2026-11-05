import type { Reading } from '../deye/types.js';

export type GridState = 'on' | 'off';
export type Phase = 'L1' | 'L2' | 'L3';

export interface GridSample {
  state: GridState | null;
  missingPhases: Phase[];
  ambiguous: boolean;
}

const PHASES: Phase[] = ['L1', 'L2', 'L3'];

export function classifyGrid(r: Reading, offV: number, okV: number): GridSample {
  const flag = r.gridStatusOn;
  const missing: Phase[] = [];
  let known = 0;
  let borderline = false;

  r.gridVoltages.slice(0, 3).forEach((v, i) => {
    if (v === null || v === undefined) return;
    known++;
    if (v < offV) missing.push(PHASES[i]!);
    else if (v < okV) borderline = true;
  });

  if (known === 0) {
    if (flag === null) return { state: null, missingPhases: [], ambiguous: true };
    return { state: flag ? 'on' : 'off', missingPhases: [], ambiguous: false };
  }

  // Deye 3-phase drops to battery when any phase fails.
  const byVolts: GridState = missing.length > 0 ? 'off' : 'on';
  if (flag !== null && (flag ? 'on' : 'off') !== byVolts) {
    return { state: flag ? 'on' : 'off', missingPhases: missing, ambiguous: true };
  }
  return { state: byVolts, missingPhases: missing, ambiguous: borderline };
}
