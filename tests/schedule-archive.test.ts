import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { mergeArchivedDay, toArchivedDays, type ArchivedDay } from '../src/schedule/archive.js';
import { openDb } from '../src/storage/db.js';
import { dicts } from '../src/i18n/index.js';
import { Repo } from '../src/storage/repo.js';

const Z = 'Europe/Kyiv';
const at = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toMillis();
const span = (a: string, b: string) => ({ start: at(a), end: at(b) });

const day = (over: Partial<ArchivedDay>): ArchivedDay => ({
  date: '2026-11-08',
  group: '52.1',
  status: 'applies',
  outages: [span('2026-11-08T10:00', '2026-11-08T14:00')],
  plannedOutages: [span('2026-11-08T10:00', '2026-11-08T14:00')],
  updatedAt: 1,
  fetchedAt: 1,
  ...over,
});

describe('mergeArchivedDay', () => {
  it('waiting or unknown never replace a published day', () => {
    const old = day({});
    expect(mergeArchivedDay(old, day({ status: 'waiting', outages: [], plannedOutages: [], fetchedAt: 2 }))).toEqual(old);
    expect(mergeArchivedDay(old, day({ status: 'unknown', outages: [], plannedOutages: [], fetchedAt: 2 }))).toEqual(old);
  });

  it('emergency keeps the last planned outages', () => {
    const m = mergeArchivedDay(day({}), day({ status: 'emergency', outages: [], plannedOutages: [], fetchedAt: 2 }));
    expect(m.status).toBe('emergency');
    expect(m.plannedOutages).toEqual([span('2026-11-08T10:00', '2026-11-08T14:00')]);
    expect(m.fetchedAt).toBe(2);
  });

  it('a newer published schedule replaces both lists', () => {
    const next = [span('2026-11-08T18:00', '2026-11-08T22:00')];
    const m = mergeArchivedDay(day({}), day({ outages: next, plannedOutages: [], fetchedAt: 2 }));
    expect(m.outages).toEqual(next);
    expect(m.plannedOutages).toEqual(next);
  });

  it('stores whatever comes first', () => {
    const u = day({ status: 'unknown', outages: [], plannedOutages: [] });
    expect(mergeArchivedDay(null, u)).toEqual(u);
  });
});

describe('toArchivedDays', () => {
  it('one record per schedule day', () => {
    const days = toArchivedDays({
      group: '52.1',
      updatedAt: 5,
      fetchedAt: 6,
      unknownTypes: [],
      days: [
        { date: '2026-11-08', status: 'applies', outages: [span('2026-11-08T10:00', '2026-11-08T14:00')] },
        { date: '2026-11-09', status: 'waiting', outages: [] },
      ],
    });
    expect(days.map((d) => [d.date, d.status, d.plannedOutages.length, d.group, d.fetchedAt])).toEqual([
      ['2026-11-08', 'applies', 1, '52.1', 6],
      ['2026-11-09', 'waiting', 0, '52.1', 6],
    ]);
  });
});

describe('schedule archive in the DB', () => {
  const repo = () => new Repo(openDb(':memory:'));

  it('round-trips and lists a date range sorted', () => {
    const r = repo();
    for (const d of ['2026-11-09', '2026-11-01', '2026-11-03', '2026-11-08']) r.putScheduleDay(day({ date: d }));
    expect(r.getScheduleDay('2026-11-03')?.date).toBe('2026-11-03');
    expect(r.getScheduleDay('2026-10-01')).toBeNull();
    expect(r.scheduleDaysBetween('2026-11-02', '2026-11-08').map((d) => d.date)).toEqual(['2026-11-03', '2026-11-08']);
    expect(r.oldestScheduleDate()).toBe('2026-11-01');
  });

  it('purges days before the cutoff date', () => {
    const r = repo();
    for (const d of ['2026-08-09', '2026-08-10', '2026-11-08']) r.putScheduleDay(day({ date: d }));
    expect(r.purgeOlderThan(at('2026-08-10T12:00'), '2026-08-10').scheduleDays).toBe(1);
    expect(r.oldestScheduleDate()).toBe('2026-08-10');
  });
});

describe('ScheduleService archive', () => {
  it('seeds the archive from the stored schedule and keeps a published day over a later "waiting"', async () => {
    const { ScheduleService } = await import('../src/schedule/service.js');
    const r = new Repo(openDb(':memory:'));
    r.setKv('schedule:address', { streetId: 1, street: 'вул. Садова', houseId: 2, house: '12/к2', group: '52.1', resolvedAt: Date.now() });
    const planned = [span('2026-11-08T10:00', '2026-11-08T14:00')];
    r.setKv('schedule:last', { group: '52.1', updatedAt: 1, fetchedAt: 1, unknownTypes: [], days: [{ date: '2026-11-08', status: 'applies', outages: planned }] });
    const svc = new ScheduleService(r, {} as never, Z, () => {});
    svc.seedArchive();
    expect(r.getScheduleDay('2026-11-08')?.outages).toEqual(planned);
    svc.saveArchive({ group: '52.1', updatedAt: 2, fetchedAt: 2, unknownTypes: [], days: [{ date: '2026-11-08', status: 'waiting', outages: [] }] });
    expect(r.getScheduleDay('2026-11-08')?.status).toBe('applies');
  });
});

describe('archive stats', async () => {
  const { archiveStats, totals, weekDates, monthDates, quarterWeeks, trend } = await import('../src/schedule/archive.js');
  const H = 3_600_000;
  const now = at('2026-11-08T09:30');
  const map = (...days: ArchivedDay[]) => new Map(days.map((d) => [d.date, d]));

  it('planned hours from the published spans', () => {
    const d = day({ date: '2026-11-07', outages: [span('2026-11-07T10:00', '2026-11-07T14:00'), span('2026-11-07T18:00', '2026-11-07T20:00')] });
    const [s] = archiveStats(['2026-11-07'], map(d), [], [], now, Z, 0);
    expect(s).toMatchObject({ kind: 'planned', plannedMs: 6 * H, dayMs: 24 * H });
    expect(s!.spans).toHaveLength(2);
  });

  it('actual hours clip open outage', () => {
    const outages = [{ start: at('2026-11-07T22:00'), end: null }];
    const s = archiveStats(['2026-11-07', '2026-11-08'], map(day({ date: '2026-11-07' }), day({ date: '2026-11-08' })), outages, [], now, Z, 0);
    expect(s.map((x) => x.actualMs)).toEqual([2 * H, 9.5 * H]);
  });

  it('emergency counts in actual totals only; waiting is no data', () => {
    const out = [{ start: at('2026-11-06T08:00'), end: at('2026-11-06T14:00') }];
    const s = archiveStats(
      ['2026-11-05', '2026-11-06'],
      map(day({ date: '2026-11-05', status: 'waiting', outages: [], plannedOutages: [] }), day({ date: '2026-11-06', status: 'emergency', outages: [] })),
      out,
      [],
      now,
      Z,
      0,
    );
    expect(s.map((x) => x.kind)).toEqual(['nodata', 'emergency']);
    expect(s[1]!.plannedMs).toBe(0);
    expect(totals(s)).toMatchObject({ plannedMs: 0, actualMs: 6 * H, daysKnown: 1, daysWithOutages: 0 });
  });

  it('tomorrow from the schedule, later days are future, nothing before the data starts', () => {
    const s = archiveStats(['2026-11-01', '2026-11-09', '2026-11-10'], map(day({ date: '2026-11-01' }), day({ date: '2026-11-09' })), [], [], now, Z, at('2026-11-04T05:40'));
    expect(s.map((x) => [x.kind, x.actualMs])).toEqual([
      ['planned', null],
      ['planned', null],
      ['future', null],
    ]);
  });

  it('totals: days with outages and the worst day by planned hours', () => {
    const s = archiveStats(
      ['2026-11-02', '2026-11-03', '2026-11-04'],
      map(day({ date: '2026-11-02', outages: [span('2026-11-02T00:00', '2026-11-02T08:00')] }), day({ date: '2026-11-03', outages: [] }), day({ date: '2026-11-04', outages: [span('2026-11-04T10:00', '2026-11-04T12:00')] })),
      [],
      [],
      now,
      Z,
      0,
    );
    expect(totals(s)).toMatchObject({ plannedMs: 10 * H, daysWithOutages: 2, daysKnown: 3, worst: { date: '2026-11-02', ms: 8 * H } });
  });

  it('DST days', () => {
    const d = day({ date: '2026-10-25', outages: [span('2026-10-25T00:00', '2026-10-26T00:00')] });
    const [s] = archiveStats(['2026-10-25'], map(d), [], [], now, Z, 0);
    expect(s!.dayMs).toBe(25 * H);
    expect(s!.plannedMs).toBe(25 * H);
  });

  it('periods: Mon–Sun week, calendar month, 13 weeks', () => {
    expect(weekDates('2026-11-08', Z)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(monthDates('2026-10', Z)).toHaveLength(31);
    expect(monthDates('2026-10', Z)[0]).toBe('2026-10-01');
    const q = quarterWeeks('2026-11-08', Z);
    expect(q).toHaveLength(13);
    expect(q.at(-1)![0]).toBe('2026-11-02');
    expect(q[0]![0]).toBe('2026-08-10');
  });

  it('trend: last 4 weeks vs the 4 before, only with 8 known weeks', () => {
    const w = (h: number, known = 7) => ({ plannedMs: h * H, actualMs: 0, daysWithOutages: 0, daysKnown: known, worst: null });
    expect(trend([w(25), w(25), w(25), w(25), w(25), w(25), w(25)])).toBeNull();
    expect(trend([w(25), w(25), w(25), w(25), w(31.25), w(31.25), w(31.25), w(31.25)])).toBeCloseTo(0.25);
    expect(trend([w(0), w(0), w(0), w(0), w(5), w(5), w(5), w(5)])).toBeNull();
    expect(trend([w(25, 0), w(25), w(25), w(25), w(25), w(25), w(25), w(25)])).toBeNull();
    // The current week is partly known (2 days of 8 h): same daily rate → no trend.
    expect(trend([w(56), w(56), w(56), w(56), w(56), w(56), w(56), w(16, 2)])).toBe(0);
  });
});

describe('archive failures never break the schedule', () => {
  const sched = (date: string) => ({ group: '52.1', updatedAt: 1, fetchedAt: 1, unknownTypes: [], days: [{ date, status: 'applies' as const, outages: [span(`${date}T10:00`, `${date}T14:00`)] }] });
  const broken = () => {
    const r = new Repo(openDb(':memory:'));
    r.setKv('schedule:address', { streetId: 1, street: 'вул. Садова', houseId: 2, house: '12/к2', group: '52.1', resolvedAt: Date.now() });
    r.setKv('schedule:last', sched('2026-11-08'));
    r.putScheduleDay = () => {
      throw new Error('disk I/O error');
    };
    return r;
  };

  it('seeding on startup does not throw', async () => {
    const { ScheduleService } = await import('../src/schedule/service.js');
    expect(() => new ScheduleService(broken(), {} as never, Z, () => {}).seedArchive()).not.toThrow();
  });

  it('a fetch still succeeds when the archive write fails', async () => {
    const { ScheduleService } = await import('../src/schedule/service.js');
    const r = broken();
    const client = { planned: async () => sched('2026-11-09'), group: async () => '52.1' };
    expect(await new ScheduleService(r, client as never, Z, () => {}).refresh(false)).toBe('ok');
    expect(r.getKv<{ days: { date: string }[] }>('schedule:last')?.days[0]?.date).toBe('2026-11-09');
  });
});

describe('YASNO no longer knows the stored address', () => {
  it('tells the admin once instead of failing silently every poll', async () => {
    const { ScheduleService } = await import('../src/schedule/service.js');
    const r = new Repo(openDb(':memory:'));
    r.setKv('schedule:address', { streetId: 101, street: 'вул. Садова', houseId: 2001, house: '12/к2', group: '52.1', resolvedAt: 0 });
    const notices: string[] = [];
    const client = {
      group: async () => {
        throw new Error('YASNO /addresses/v2/group: HTTP 404');
      },
      streets: async () => [{ id: 102, name: 'вул. Садова' }],
      houses: async () => [{ id: 1, name: '12' }], // the stored house isn't there any more
      planned: async () => ({ group: '52.1', updatedAt: 1, fetchedAt: 1, unknownTypes: [], days: [] }),
    };
    const svc = new ScheduleService(r, client as never, Z, (render) => notices.push(render(dicts.uk).text));
    expect(await svc.refresh(false)).toBe('ok');
    expect(await svc.refresh(false)).toBe('ok');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Адреса');
  });

  it('seeding never throws even when reading the DB fails', async () => {
    const { ScheduleService } = await import('../src/schedule/service.js');
    const r = new Repo(openDb(':memory:'));
    r.getKv = () => {
      throw new Error('database disk image is malformed');
    };
    expect(() => new ScheduleService(r, {} as never, Z, () => {}).seedArchive()).not.toThrow();
  });
});

describe('YASNO renumbered the address', () => {
  it('finds the new street and house ids by name and keeps going without bothering the owner', async () => {
    const { ScheduleService } = await import('../src/schedule/service.js');
    const r = new Repo(openDb(':memory:'));
    r.setKv('schedule:address', { streetId: 101, street: 'вул. Садова', houseId: 2001, house: '12/к2', group: '52.1', resolvedAt: 0 });
    const notices: string[] = [];
    const asked: string[] = [];
    const client = {
      group: async (streetId: number, houseId: number) => {
        if (streetId === 102 && houseId === 2002) return '52.1';
        throw new Error('YASNO /addresses/v2/group: HTTP 404');
      },
      streets: async (q: string) => (asked.push(`street:${q}`), [{ id: 900, name: 'вул. Садова (Дарниця)' }, { id: 102, name: 'вул. Садова' }]),
      houses: async (streetId: number, q: string) => (asked.push(`house:${streetId}:${q}`), [{ id: 2003, name: '12/к1' }, { id: 2002, name: '12/К2' }]),
      planned: async () => ({ group: '52.1', updatedAt: 1, fetchedAt: 1, unknownTypes: [], days: [] }),
    };
    const svc = new ScheduleService(r, client as never, Z, (render) => notices.push(render(dicts.uk).text));
    expect(await svc.refresh(false)).toBe('ok');
    expect(svc.address()).toMatchObject({ streetId: 102, houseId: 2002, street: 'вул. Садова', house: '12/к2', group: '52.1' });
    expect(asked).toEqual(['street:вул. Садова', 'house:102:12/к2']);
    expect(notices).toEqual([]);
  });
});
