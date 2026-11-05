import { describe, expect, it } from 'vitest';
import { fitFont } from '../src/render/cards.js';

describe('fitFont', () => {
  it('keeps the base size when the text fits', () => {
    expect(fitFont('77%', 160, 26)).toBe(26);
  });

  it('shrinks long values so they stay inside their column', () => {
    const size = fitFont('180.0 кВт·год', 160, 26);
    expect(size).toBeLessThan(26);
    expect('180.0 кВт·год'.length * size * 0.6).toBeLessThanOrEqual(160);
  });
});
