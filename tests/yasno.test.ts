import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { parseGroup, parseOptions, parsePlanned, YasnoClient, YasnoFormatError } from '../src/schedule/yasno.js';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/yasno/${name}.json`, import.meta.url), 'utf8'));
const Z = 'Europe/Kyiv';
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();

describe('parsePlanned', () => {
  it('maps the real response for group 52.1', () => {
    const s = parsePlanned(fx('planned-outages'), '52.1', 123);
    expect(s.group).toBe('52.1');
    expect(s.fetchedAt).toBe(123);
    expect(s.updatedAt).toBe(Date.parse('2026-11-04T18:15:01+00:00'));
    expect(s.days[0]).toEqual({
      date: '2026-11-04',
      status: 'applies',
      outages: [
        { start: at('2026-11-04T10:00'), end: at('2026-11-04T20:00') },
        { start: at('2026-11-04T22:00'), end: at('2026-11-05T00:00') },
      ],
    });
    expect(s.days[1]).toEqual({ date: '2026-11-05', status: 'waiting', outages: [] });
    expect(s.unknownTypes).toEqual([]);
  });

  it('rejects a broken structure', () => {
    expect(() => parsePlanned(fx('planned-outages'), '99.9', 0)).toThrow(YasnoFormatError);
    expect(() => parsePlanned(null, '52.1', 0)).toThrow(YasnoFormatError);
    const bad = { '52.1': { today: { date: '2026-11-04T00:00:00+02:00', status: 'ScheduleApplies', slots: 'x' }, tomorrow: null } };
    expect(() => parsePlanned(bad, '52.1', 0)).toThrow(YasnoFormatError);
  });

  it('builds DST days from local midnight (25-hour day)', () => {
    const day = { date: '2026-10-25T00:00:00+03:00', status: 'ScheduleApplies', slots: [{ start: 0, end: 1440, type: 'Definite' }] };
    const s = parsePlanned({ '1.1': { today: day, tomorrow: { date: '2026-10-26T00:00:00+02:00', status: 'WaitingForSchedule', slots: [] } } }, '1.1', 0);
    const o = s.days[0]!.outages[0]!;
    expect(o.start).toBe(at('2026-10-25T00:00'));
    expect(o.end).toBe(at('2026-10-26T00:00'));
    expect((o.end - o.start) / 3_600_000).toBe(25);
  });

  it('treats an unknown slot type as an outage and reports it', () => {
    const day = {
      date: '2026-11-04T00:00:00+02:00',
      status: 'ScheduleApplies',
      slots: [
        { start: 0, end: 60, type: 'Possible' },
        { start: 60, end: 120, type: 'Definite' },
        { start: 120, end: 1440, type: 'NotPlanned' },
      ],
    };
    const s = parsePlanned({ '1.1': { today: day, tomorrow: { ...day, date: '2026-11-05T00:00:00+02:00', status: 'Something' } } }, '1.1', 0);
    expect(s.unknownTypes).toEqual(['Possible']);
    expect(s.days[0]!.outages).toEqual([{ start: at('2026-11-04T00:00'), end: at('2026-11-04T02:00') }]); // merged
    expect(s.days[1]!.status).toBe('unknown');
  });
});

describe('spring-forward day', () => {
  it('drops a slot that falls into the skipped hour', () => {
    const day = { date: '2026-03-29T00:00:00+02:00', status: 'ScheduleApplies', slots: [{ start: 180, end: 240, type: 'Definite' }, { start: 600, end: 660, type: 'Definite' }] };
    const s = parsePlanned({ '1.1': { today: day, tomorrow: { date: '2026-03-30T00:00:00+03:00', status: 'WaitingForSchedule', slots: [] } } }, '1.1', 0);
    expect(s.days[0]!.outages).toEqual([{ start: at('2026-03-29T10:00'), end: at('2026-03-29T11:00') }]);
  });
});

describe('address lookups', () => {
  it('parses group, streets and houses', () => {
    expect(parseGroup(fx('group'))).toBe('52.1');
    expect(parseOptions(fx('streets'))).toEqual([{ id: 101, name: 'вул. Садова' }]);
    expect(parseOptions(fx('houses'))).toContainEqual({ id: 2002, name: '12/к2' });
    expect(() => parseGroup({ group: 'x' })).toThrow(YasnoFormatError);
  });
});

describe('YasnoClient', () => {
  it('calls the Kyiv endpoints with the right parameters', async () => {
    const urls: string[] = [];
    const bodies = [fx('planned-outages'), fx('group')];
    const fetchFn = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(JSON.stringify(bodies.shift()), { status: 200 });
    }) as typeof fetch;
    const c = new YasnoClient(fetchFn);
    await c.planned('52.1');
    expect(await c.group(101, 2002)).toBe('52.1');
    expect(urls[0]).toBe('https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages');
    expect(urls[1]).toContain('/addresses/v2/group?regionId=25&dsoId=902&streetId=101&houseId=2002');
  });
});
