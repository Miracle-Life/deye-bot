import { describe, expect, it } from 'vitest';
import { backupName, backupPlan } from '../src/backup.js';

describe('backupPlan', () => {
  it('one backup per date: none needed when today exists', () => {
    expect(backupPlan(['deye-2026-11-04.db.gz'], '2026-11-04').needToday).toBe(false);
    expect(backupPlan(['deye-2026-11-03.db.gz'], '2026-11-04').needToday).toBe(true);
    expect(backupName('2026-11-04')).toBe('deye-2026-11-04.db.gz');
  });

  it('removes copies older than 90 days and leftovers of interrupted runs, nothing else', () => {
    const files = ['deye-2026-08-05.db.gz', 'deye-2026-08-06.db.gz', 'deye-2026-11-04.db.gz', 'deye-2026-11-05.db.gz.tmp', 'deye-2026-11-05.db.tmp', 'notes.txt', 'deye.db'];
    expect(backupPlan(files, '2026-11-04').remove.sort()).toEqual(['deye-2026-08-05.db.gz', 'deye-2026-11-05.db.gz.tmp', 'deye-2026-11-05.db.tmp']);
  });

  it('never more than 90 dated copies', () => {
    const files = Array.from({ length: 120 }, (_, i) => backupName(new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10)));
    const p = backupPlan(files, '2026-11-28');
    expect(files.length - p.remove.length).toBeLessThanOrEqual(91);
  });
});

describe('runBackup after a killed run', () => {
  it('a leftover temp file does not break the next backup of the same day', async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { DatabaseSync } = await import('node:sqlite');
    const { runBackup } = await import('../src/backup.js');
    const dir = mkdtempSync(join(tmpdir(), 'deye-bk-'));
    const db = join(dir, 'deye.db');
    const d = new DatabaseSync(db);
    d.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
    d.close();
    const out = join(dir, 'backups');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(out);
    writeFileSync(join(out, 'deye-2026-11-04.db.tmp'), 'half a copy');
    await runBackup(db, out, '2026-11-04', new URL('../src/backup-worker.ts', import.meta.url));
    expect(readdirSync(out)).toEqual(['deye-2026-11-04.db.gz']);
  });
});
