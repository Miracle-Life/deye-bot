import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { ErrorDigest, initialCloud, isQuietHour, isStartupNetError, stepCloud } from '../src/domain/ops.js';

const MIN = 60_000;

describe('stepCloud', () => {
  it('reports down after 10 min of failures, then up once', () => {
    let r = stepCloud(initialCloud, { ok: false, auth: false, error: 'HTTP 502' }, 0, 10 * MIN);
    expect(r.event).toBeNull();
    r = stepCloud(r.state, { ok: false, auth: false, error: 'HTTP 502' }, 9 * MIN, 10 * MIN);
    expect(r.event).toBeNull();
    r = stepCloud(r.state, { ok: false, auth: false, error: 'timeout' }, 10 * MIN, 10 * MIN);
    expect(r.event).toEqual({ type: 'cloud_down', sinceTs: 0, error: 'timeout' });
    r = stepCloud(r.state, { ok: false, auth: false, error: 'timeout' }, 12 * MIN, 10 * MIN);
    expect(r.event).toBeNull();
    r = stepCloud(r.state, { ok: true }, 15 * MIN, 10 * MIN);
    expect(r.event).toEqual({ type: 'cloud_up', sinceTs: 0, ts: 15 * MIN });
  });

  it('auth errors are reported immediately and once', () => {
    let r = stepCloud(initialCloud, { ok: false, auth: true, error: 'wrong password' }, 0, 10 * MIN);
    expect(r.event).toEqual({ type: 'cloud_auth', error: 'wrong password' });
    r = stepCloud(r.state, { ok: false, auth: true, error: 'wrong password' }, MIN, 10 * MIN);
    expect(r.event).toBeNull();
  });

  it('a short blip says nothing on recovery', () => {
    let r = stepCloud(initialCloud, { ok: false, auth: false, error: 'x' }, 0, 10 * MIN);
    r = stepCloud(r.state, { ok: true }, MIN, 10 * MIN);
    expect(r.event).toBeNull();
    expect(r.state).toEqual(initialCloud);
  });
});

describe('ErrorDigest', () => {
  it('sends the first error, counts repeats within an hour, summarizes them later', () => {
    const d = new ErrorDigest(60 * MIN);
    expect(d.add('render failed', 0)).toBe(true);
    expect(d.add('render failed', MIN)).toBe(false);
    expect(d.add('render failed', 2 * MIN)).toBe(false);
    expect(d.add('other', 2 * MIN)).toBe(true);
    expect(d.flush(30 * MIN)).toEqual([]);
    expect(d.flush(61 * MIN)).toEqual([{ key: 'render failed', count: 2 }]);
    expect(d.add('render failed', 62 * MIN)).toBe(true);
  });
});

describe('isQuietHour', () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Kyiv' }).toMillis();
  it('23:00–07:00 Kyiv time', () => {
    expect(isQuietHour(at('2026-11-04T23:00'), 'Europe/Kyiv')).toBe(true);
    expect(isQuietHour(at('2026-11-05T06:59'), 'Europe/Kyiv')).toBe(true);
    expect(isQuietHour(at('2026-11-05T07:00'), 'Europe/Kyiv')).toBe(false);
    expect(isQuietHour(at('2026-11-04T22:59'), 'Europe/Kyiv')).toBe(false);
  });
});

describe('isStartupNetError', () => {
  const dns = 'fetch failed: EAI_AGAIN getaddrinfo EAI_AGAIN eu1-developer.deyecloud.com';
  it('network errors in the first 2 minutes are startup noise', () => {
    expect(isStartupNetError(dns, 0, 30_000)).toBe(true);
    expect(isStartupNetError('connect ECONNREFUSED 1.2.3.4:443', 0, 119_000)).toBe(true);
  });

  it('later or non-network errors still count', () => {
    expect(isStartupNetError(dns, 0, 5 * 60_000)).toBe(false);
    expect(isStartupNetError('Deye /device/latest: HTTP 500', 0, 30_000)).toBe(false);
  });
});
