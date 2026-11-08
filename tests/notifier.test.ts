import { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import { broadcast, type SendApi } from '../src/bot/notifier.js';
import { heartbeatPayload, pollerAlive } from '../src/heartbeat.js';
import type { UserRow } from '../src/storage/repo.js';

const user = (tgId: number, muted = false, nightQuiet = false): UserRow => ({ tgId, name: `u${tgId}`, username: null, status: 'approved', muted, nightQuiet, watchdog: false, lang: 'ru', remindOffMin: 30, remindOnMin: 30, createdAt: 0 });

function fakeApi(fail: Record<number, unknown> = {}, photoFails = false) {
  const calls: { chatId: number; silent: boolean; photo?: string }[] = [];
  const texts: string[] = [];
  const markups: unknown[] = [];
  let nextId = 100;
  const api: SendApi = {
    async sendMessage(chatId, text, opts) {
      if (fail[chatId]) throw fail[chatId];
      calls.push({ chatId, silent: opts.disable_notification });
      texts.push(text);
      markups.push(opts.reply_markup);
      return { message_id: nextId++ };
    },
    async sendPhoto(chatId, photo, opts) {
      if (fail[chatId]) throw fail[chatId];
      if (photoFails) throw { error_code: 400, description: 'Bad Request: IMAGE_PROCESS_FAILED' };
      calls.push({ chatId, silent: opts.disable_notification, photo: typeof photo === 'string' ? photo : 'upload' });
      markups.push(opts.reply_markup);
      return { message_id: nextId++, photo: [{ file_id: 'small' }, { file_id: 'big' }] };
    },
  };
  return { api, calls, markups, texts };
}

describe('broadcast', () => {
  it('broadcast continues when one user blocked', async () => {
    const { api, calls } = fakeApi({ 2: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
    const blocked: number[] = [];
    const res = await broadcast(api, [user(1), user(2), user(3)], { text: 'x', silent: false }, (id) => blocked.push(id));
    expect(res).toEqual({ sent: 2, failed: 1 });
    expect(blocked).toEqual([2]);
    expect(calls.map((c) => c.chatId)).toEqual([1, 3]);
  });

  it('muted user gets silent', async () => {
    const { api, calls } = fakeApi();
    await broadcast(api, [user(1, true), user(2)], { text: 'x', silent: false }, () => {});
    expect(calls).toEqual([
      { chatId: 1, silent: true },
      { chatId: 2, silent: false },
    ]);
  });

  it('night-quiet users get silent messages only during quiet hours', async () => {
    const night = fakeApi();
    await broadcast(night.api, [user(1, false, true), user(2)], { text: 'x', silent: false }, () => {}, true);
    expect(night.calls.map((c) => c.silent)).toEqual([true, false]);
    const day = fakeApi();
    await broadcast(day.api, [user(1, false, true)], { text: 'x', silent: false }, () => {}, false);
    expect(day.calls.map((c) => c.silent)).toEqual([false]);
  });

  it('photo is uploaded once, then reused by file_id', async () => {
    const { api, calls } = fakeApi();
    await broadcast(api, [user(1), user(2)], { text: 'x', silent: false, photo: Buffer.from('png') }, () => {});
    expect(calls.map((c) => c.photo)).toEqual(['upload', 'big']);
  });

  it('falls back to text when the photo is rejected', async () => {
    const { api, calls } = fakeApi({}, true);
    const res = await broadcast(api, [user(1)], { text: 'x', silent: false, photo: Buffer.from('png') }, () => {});
    expect(res).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual([{ chatId: 1, silent: false }]);
  });
});

describe('broadcast with the panel keyboard', () => {
  const kb = new InlineKeyboard().text('🔄', 'r:panel');

  it('attaches the keyboard to the photo and reports the sent message', async () => {
    const { api, markups } = fakeApi();
    const sent: [number, number, boolean][] = [];
    await broadcast(api, [user(1)], { text: 'cap', silent: false, photo: Buffer.from('png'), kb }, () => {}, false, (id, mid, asPhoto) => sent.push([id, mid, asPhoto]));
    expect(markups).toEqual([kb]);
    expect(sent).toEqual([[1, 100, true]]);
  });

  it('photo fallback keeps keyboard', async () => {
    const { api, markups, texts } = fakeApi({}, true);
    const sent: [number, number, boolean][] = [];
    await broadcast(api, [user(1)], { text: 'cap', fallbackText: 'full event text', silent: false, photo: Buffer.from('png'), kb }, () => {}, false, (id, mid, asPhoto) => sent.push([id, mid, asPhoto]));
    expect(markups).toEqual([kb]);
    expect(texts).toEqual(['full event text']);
    expect(sent).toEqual([[1, 100, false]]);
  });
});

describe('heartbeatPayload', () => {
  it('lists approved users who enabled the offline alert, with their sound settings', () => {
    const users = [user(1), { ...user(2, true), watchdog: true }, { ...user(3), watchdog: true, status: 'blocked' as const }];
    const p = heartbeatPayload([{ ...users[0]!, watchdog: true, lang: 'uk' }, users[1]!, users[2]!], { timezone: 'Europe/Kyiv', quietFrom: 23, quietTo: 7 }, 5);
    expect(p).toEqual({
      ts: 5,
      tz: 'Europe/Kyiv',
      quietFrom: 23,
      quietTo: 7,
      chats: [
        { id: 1, muted: false, nightQuiet: false, lang: 'uk' },
        { id: 2, muted: true, nightQuiet: false, lang: 'ru' },
      ],
    });
  });
});

describe('pollerAlive', () => {
  const MIN = 60_000;
  it('is alive while polls keep happening', () => {
    expect(pollerAlive(100 * MIN, 0, 110 * MIN)).toBe(true);
  });

  it('is not alive when polling stalled for 15 min', () => {
    expect(pollerAlive(100 * MIN, 0, 116 * MIN)).toBe(false);
  });

  it('gives a fresh start time to begin polling', () => {
    expect(pollerAlive(0, 100 * MIN, 110 * MIN)).toBe(true);
    expect(pollerAlive(0, 100 * MIN, 116 * MIN)).toBe(false);
  });
});
