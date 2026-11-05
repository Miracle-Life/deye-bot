import { describe, expect, it } from 'vitest';
import { redact } from '../src/log.js';

describe('redact', () => {
  it('hides secret keys, auth headers and emails by key', () => {
    expect(redact({ appSecret: 'x', authorization: 'Bearer y', email: 'a@b.c', ok: 1 })).toEqual({ appSecret: '***', authorization: '***', email: '***', ok: 1 });
  });

  it('scrubs a Telegram token or a bearer token inside any string value', () => {
    expect(redact({ error: 'GET https://api.telegram.org/bot123456:AAH-x_y/getMe failed' })).toEqual({ error: 'GET https://api.telegram.org/bot***/getMe failed' });
    expect(redact({ error: 'header Bearer abc.def-ghi rejected' })).toEqual({ error: 'header Bearer *** rejected' });
    expect(redact('bot987:ZZZ')).toBe('bot***');
  });
});
