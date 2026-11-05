// Daily DB backups: data/backups/deye-YYYY-MM-DD.db.gz, one per date, kept 90 days.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { createGzip } from 'node:zlib';
import { DateTime } from 'luxon';
import { esc, type Msg } from './bot/format.js';
import type { Dict } from './i18n/index.js';
import { errInfo, log } from './log.js';

const KEEP_DAYS = 90;
const NAME = /^deye-(\d{4}-\d{2}-\d{2})\.db\.gz$/;
const RUN_HOUR = 3;
const RUN_MINUTE = 30;

export const backupName = (dateIso: string) => `deye-${dateIso}.db.gz`;

/** What to do with the backup folder: one file per date, nothing older than 90 days, no leftovers. */
export function backupPlan(files: string[], todayIso: string, keepDays = KEEP_DAYS): { needToday: boolean; remove: string[] } {
  const cutoff = DateTime.fromISO(todayIso).minus({ days: keepDays }).toISODate()!;
  const remove = files.filter((f) => f.endsWith('.tmp') || (NAME.exec(f)?.[1] ?? '9999') < cutoff);
  return { needToday: !files.includes(backupName(todayIso)), remove };
}

const WORKER = new URL('./backup-worker.js', import.meta.url);

function vacuumInto(dbPath: string, target: string, worker: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new Worker(worker, { workerData: { dbPath, target } });
    w.once('message', (m: { ok: boolean; error?: string }) => (m.ok ? resolve() : reject(new Error(m.error))));
    w.once('error', reject);
    // Settles nothing if a message came first; otherwise the promise must not hang forever.
    w.once('exit', (code) => reject(new Error(`backup worker exited (${code}) without a result`)));
  });
}

/** Copy (SQLite, in a worker) → gzip (streams) → atomic rename: a crash never leaves a half file under the final name. */
export async function runBackup(dbPath: string, dir: string, todayIso: string, worker = WORKER): Promise<{ file: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const final = join(dir, backupName(todayIso));
  const raw = `${final.slice(0, -'.gz'.length)}.tmp`;
  const gzTmp = `${final}.tmp`;
  // Leftovers of a killed run: VACUUM INTO refuses an existing target.
  await unlink(raw).catch(() => {});
  await unlink(gzTmp).catch(() => {});
  try {
    await vacuumInto(dbPath, raw, worker);
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(gzTmp));
    await rename(gzTmp, final);
    return { file: final, bytes: (await stat(final)).size };
  } finally {
    await unlink(raw).catch(() => {});
    await unlink(gzTmp).catch(() => {});
  }
}

export class Backups {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private noticedFor: string | null = null;
  private readonly dir: string;

  constructor(
    private dbPath: string,
    private tz: string,
    private notifyAdmin: (render: (t: Dict) => Msg) => void,
  ) {
    this.dir = join(dirname(dbPath), 'backups');
  }

  start(): void {
    // A minute after startup (if today's copy is missing), then every night at 03:30.
    this.timer = setTimeout(() => void this.tick(), 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const now = DateTime.now().setZone(this.tz);
    let next = now.set({ hour: RUN_HOUR, minute: RUN_MINUTE, second: 0, millisecond: 0 });
    if (next <= now) next = next.plus({ days: 1 });
    this.timer = setTimeout(() => void this.tick(), next.toMillis() - now.toMillis());
  }

  private async prune(today: string): Promise<void> {
    for (const f of backupPlan(await readdir(this.dir), today).remove) await unlink(join(this.dir, f)).catch(() => {});
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const today = DateTime.now().setZone(this.tz).toISODate()!;
    try {
      await mkdir(this.dir, { recursive: true });
      // Retention first: a full disk must be relieved even if today's copy then fails.
      await this.prune(today);
      if (backupPlan(await readdir(this.dir), today).needToday) {
        const r = await runBackup(this.dbPath, this.dir, today);
        log.info('backup done', { file: r.file, kb: Math.round(r.bytes / 1024) });
      }
      await this.prune(today);
    } catch (e) {
      log.warn('backup failed', errInfo(e));
      if (this.noticedFor !== today) {
        this.noticedFor = today;
        const why = esc(errInfo(e).error.slice(0, 300)); // cut before escaping: a split &amp; breaks the HTML
        this.notifyAdmin((t) => ({ text: t.ops.backupFailed(why), silent: true }));
      }
    } finally {
      this.running = false;
      if (!this.stopped) this.schedule();
    }
  }
}
