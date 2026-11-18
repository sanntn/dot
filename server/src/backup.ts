import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";

// Copies of the database in a folder next to it. VACUUM INTO writes a consistent snapshot while Dot keeps
// running, which a plain file copy of a WAL database cannot promise.

const PREFIX = "dot-";
const SUFFIX = ".db";

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// Newest first. The timestamp in the name sorts the same as the time it stands for.
export function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// Writes one backup and deletes the oldest beyond `keep`. Returns the new file's path.
export function backupDatabase(db: Db, dir: string, keep: number, date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${PREFIX}${stamp(date)}${SUFFIX}`);
  // A second backup in the same second would collide. Overwriting is the wrong answer, so skip the name.
  rmSync(file, { force: true });
  // VACUUM INTO takes a quoted path, not a parameter.
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  for (const old of listBackups(dir).slice(Math.max(1, keep))) rmSync(join(dir, old), { force: true });
  return file;
}

export type BackupOptions = {
  dir: string;
  // How many backups to keep. 0 turns backups off.
  keep: number;
  // A new backup is taken when the newest is older than this.
  everyMs?: number;
  checkMs?: number;
};

// Takes a backup at startup if the newest is too old, then checks every hour. Returns a function that stops it.
export function startBackups(db: Db, options: BackupOptions, log: (message: string) => void = console.log): () => void {
  if (options.keep <= 0) return () => {};
  const everyMs = options.everyMs ?? 24 * 60 * 60_000;

  const due = (): boolean => {
    const newest = listBackups(options.dir)[0];
    if (!newest) return true;
    try {
      return Date.now() - statSync(join(options.dir, newest)).mtimeMs >= everyMs;
    } catch {
      return true;
    }
  };
  const run = () => {
    if (!due()) return;
    try {
      log(`Database backed up to ${backupDatabase(db, options.dir, options.keep)}`);
    } catch (err) {
      console.error("Database backup failed:", err);
    }
  };

  run();
  const timer = setInterval(run, options.checkMs ?? 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
