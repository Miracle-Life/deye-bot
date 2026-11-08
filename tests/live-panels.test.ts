import { describe, expect, it } from 'vitest';
import { dropLive, oneAtATime } from '../src/bot/bot.js';

describe('dropLive', () => {
  it('drops the live panel only if it is still the message that failed to refresh', () => {
    const live = new Map([[1, { messageId: 20, until: 0, lang: 'uk' as const }]]);
    dropLive(live, 1, 10); // an older panel failed; a notification replaced it meanwhile
    expect(live.get(1)?.messageId).toBe(20);
    dropLive(live, 1, 20);
    expect(live.has(1)).toBe(false);
  });
});

describe('oneAtATime', () => {
  it('a refresh started while one is running is skipped, not stacked', async () => {
    let runs = 0;
    let release!: () => void;
    const f = oneAtATime(() => new Promise<void>((r) => { runs++; release = r; }));
    const a = f();
    const b = f();
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
    const c = f();
    release();
    await c;
    expect(runs).toBe(2);
  });
});
