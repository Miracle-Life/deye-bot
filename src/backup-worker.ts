// Runs VACUUM INTO on its own connection in a worker thread: node:sqlite is synchronous,
// and copying on the bot's connection would freeze it for the whole copy.
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const { dbPath, target } = workerData as { dbPath: string; target: string };
try {
  const db = new DatabaseSync(dbPath, { readOnly: true }); // a copy never needs to write the source
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  parentPort?.postMessage({ ok: true });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
