import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase, listBackups, startBackups } from "../src/backup.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { ProjectInputSchema } from "@dot/shared";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "dot-backup-"));
  dirs.push(d);
  return d;
};

test("a backup holds the data, and only the newest few are kept", () => {
  const dir = temp();
  const db = openDb(join(dir, "dot.db"));
  new Store(db).createProject(ProjectInputSchema.parse({ name: "Kept", repoPath: dir, baseBranch: "main" }));

  const backups = join(dir, "backups");
  for (let day = 1; day <= 4; day++) backupDatabase(db, backups, 3, new Date(2026, 0, day, 3, 0, 0));
  assert.deepEqual(listBackups(backups), ["dot-2026-01-04-030000.db", "dot-2026-01-03-030000.db", "dot-2026-01-02-030000.db"]);

  const copy = new DatabaseSync(join(backups, listBackups(backups)[0]!), { readOnly: true });
  const row = copy.prepare("SELECT name FROM projects").get() as { name: string };
  assert.equal(row.name, "Kept");
  copy.close();
  db.close();
});

test("startup takes a backup only when the newest one is old", () => {
  const dir = temp();
  const db = openDb(":memory:");
  const backups = join(dir, "backups");
  const messages: string[] = [];

  const stop = startBackups(db, { dir: backups, keep: 5, checkMs: 1_000_000 }, (m) => messages.push(m));
  stop();
  assert.equal(listBackups(backups).length, 1);

  // Fresh backup: a restart makes no second one.
  startBackups(db, { dir: backups, keep: 5, checkMs: 1_000_000 }, (m) => messages.push(m))();
  assert.equal(listBackups(backups).length, 1);

  // Two days old: due again.
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  utimesSync(join(backups, listBackups(backups)[0]!), old, old);
  startBackups(db, { dir: backups, keep: 5, checkMs: 1_000_000 }, (m) => messages.push(m))();
  assert.equal(messages.length, 2);

  // keep 0 means off.
  const off = join(dir, "off");
  startBackups(db, { dir: off, keep: 0 })();
  assert.equal(existsSync(off), false);
  db.close();
});
