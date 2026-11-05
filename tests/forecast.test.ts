import { describe, expect, it } from 'vitest';
import { runtimeHours, timeToFullMin } from '../src/domain/forecast.js';

describe('runtimeHours', () => {
  it('72% at 211 W with 24 kWh and 10% reserve ≈ 70.5 h', () => {
    expect(runtimeHours(72, 211, 24, 10)).toBeCloseTo(70.5, 1);
  });
  it('no load → null', () => {
    expect(runtimeHours(72, 0, 24, 10)).toBeNull();
  });
  it('at or below reserve → 0', () => {
    expect(runtimeHours(10, 300, 24, 10)).toBe(0);
  });
});

describe('timeToFullMin', () => {
  it('26% charging 3200 W on 24 kWh ≈ 333 min', () => {
    expect(timeToFullMin(26, 3200, 24)).toBeCloseTo(333, 0);
  });
  it('weak charge → null', () => {
    expect(timeToFullMin(50, 80, 24)).toBeNull();
  });
  it('full → 0', () => {
    expect(timeToFullMin(100, 500, 24)).toBe(0);
  });
});
