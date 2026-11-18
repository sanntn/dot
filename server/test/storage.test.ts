import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProjectInputSchema } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { cleanStorage, sizeOf, storageReport } from "../src/storage.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("cleaning removes finished worktrees and orphan folders, and leaves open tasks alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-storage-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });

  const worktreesDir = join(dir, "worktrees");
  const folder = (name: string, bytes: number) => {
    mkdirSync(join(worktreesDir, name), { recursive: true });
    writeFileSync(join(worktreesDir, name, "file.bin"), Buffer.alloc(bytes));
    return join(worktreesDir, name);
  };

  const store = new Store(openDb(":memory:"));
  const project = store.createProject(ProjectInputSchema.parse({ name: "P", repoPath: repo, baseBranch: "main" }));
  const done = store.createTask({ projectId: project.id, title: "Finished", description: "", blockedBy: [] });
  const open = store.createTask({ projectId: project.id, title: "Open", description: "", blockedBy: [] });
  store.setTaskWorkspace(done.id, "dot/1-finished", folder("1", 3000));
  store.setTaskWorkspace(open.id, "dot/2-open", folder("2", 2000));
  store.moveTask(done.id, { column: "done", beforeTaskId: null });
  store.moveTask(open.id, { column: "execute", beforeTaskId: null });
  folder("stray", 1000);

  const paths = { worktreesDir, dbFile: join(dir, "none.db"), backupsDir: join(dir, "backups"), attachmentsDir: join(dir, "att") };
  const report = await storageReport(store, paths);
  assert.deepEqual(report.worktrees.map((w) => [w.number, w.removable, w.bytes]), [
    [1, true, 3000],
    [2, false, 2000],
  ]);
  assert.deepEqual(report.orphans, [{ name: "stray", bytes: 1000 }]);

  const result = await cleanStorage(store, paths);
  assert.deepEqual(result, { removed: 2, freedBytes: 4000 });
  assert.equal(existsSync(join(worktreesDir, "1")), false);
  assert.equal(existsSync(join(worktreesDir, "stray")), false);
  assert.equal(existsSync(join(worktreesDir, "2")), true);
  assert.equal(await sizeOf(join(dir, "missing")), 0);
});
