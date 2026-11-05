import { describe, expect, it } from 'vitest';
import { classifyGrid } from '../src/domain/grid.js';
import { emptyReading } from '../src/deye/types.js';

const r = (v: (number | null)[], flag: boolean | null = null) => ({ ...emptyReading(0), gridVoltages: v, gridStatusOn: flag });

describe('classifyGrid', () => {
  it('all phases ~230 → on, not ambiguous', () => {
    expect(classifyGrid(r([229, 231, 230]), 50, 180)).toEqual({ state: 'on', missingPhases: [], ambiguous: false });
  });

  it('one phase 0 → off with L2', () => {
    expect(classifyGrid(r([230, 0, 231]), 50, 180)).toEqual({ state: 'off', missingPhases: ['L2'], ambiguous: false });
  });

  it('all zero → off', () => {
    expect(classifyGrid(r([0, 0, 0]), 50, 180)).toEqual({ state: 'off', missingPhases: ['L1', 'L2', 'L3'], ambiguous: false });
  });

  it('borderline 120V → ambiguous', () => {
    expect(classifyGrid(r([230, 120, 230]), 50, 180).ambiguous).toBe(true);
  });

  it('no voltages, no flag → null state', () => {
    expect(classifyGrid(r([null, null, null]), 50, 180)).toEqual({ state: null, missingPhases: [], ambiguous: true });
  });

  it('no voltages, flag off → off by flag, not ambiguous', () => {
    expect(classifyGrid(r([null, null, null], false), 50, 180)).toMatchObject({ state: 'off', ambiguous: false });
  });

  it('flag contradicts voltages → ambiguous, state by flag', () => {
    expect(classifyGrid(r([230, 230, 230], false), 50, 180)).toMatchObject({ state: 'off', ambiguous: true });
  });
});
