import { describe, expect, it } from 'vitest';
import { nextPollDelay, updateTiming } from '../src/domain/schedule.js';

const S = 1000;
const t = { periodMs: 180 * S, lagMs: 40 * S };

describe('nextPollDelay', () => {
  it('sleeps until the next frame should be visible in the cloud', () => {
    // frame at 0, seen at 40 s → next frame at 180 s, visible ≈ 220 s
    expect(nextPollDelay(40 * S, 0, t, 60 * S, 0)).toBe(182 * S);
  });

  it('retries fast while the expected frame is late', () => {
    expect(nextPollDelay(230 * S, 0, t, 60 * S, 0)).toBe(10 * S);
  });

  it('falls back to the base interval when the logger is silent for long', () => {
    expect(nextPollDelay(600 * S, 0, t, 60 * S, 0)).toBe(60 * S);
  });

  it('backs off on failures', () => {
    expect(nextPollDelay(40 * S, 0, t, 60 * S, 2)).toBe(240 * S);
  });

  it('uses the base interval before the first reading', () => {
    expect(nextPollDelay(0, null, t, 60 * S, 0)).toBe(60 * S);
  });
});

describe('updateTiming', () => {
  it('learns the period and takes a faster lag immediately', () => {
    expect(updateTiming(t, 0, 181 * S, 191 * S)).toEqual({ periodMs: 181 * S, lagMs: 10 * S });
  });

  it('raises the lag slowly and ignores odd periods', () => {
    expect(updateTiming(t, 0, 3600 * S, 3690 * S)).toEqual({ periodMs: 180 * S, lagMs: 50 * S });
  });
});
