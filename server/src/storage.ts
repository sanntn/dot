import { existsSync, rmSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { StorageReport } from "@dot/shared";
import { gitOk, removeWorktree, uncommittedChanges } from "./git.ts";
import type { Store } from "./store.ts";

// What Dot keeps on disk, and cleanup of the part that is safe to delete: worktrees of finished tasks and
// folders in the worktrees directory that no task owns. A worktree of an open task may hold uncommitted
// work, so it is listed but never removed here.

// At most this many file system calls at once. A folder like node_modules has tens of thousands of entries,
// and one call per entry all at once would queue them without limit.
const MAX_CONCURRENT = 64;
let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

// Total size of a file or folder. Symbolic links count as themselves and are not followed.
export async function sizeOf(path: string): Promise<number> {
  let info;
  try {
    info = await limited(() => lstat(path));
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let names: string[];
  try {
    names = await limited(() => readdir(path));
  } catch {
    return 0;
  }
  const sizes = await Promise.all(names.map((name) => sizeOf(join(path, name))));
  return sizes.reduce((a, b) => a + b, 0);
}

// A folder this young may belong to a worktree being created right now, before its task records the path.
const ORPHAN_MIN_AGE_MS = 60 * 60_000;

export type StoragePaths = { worktreesDir: string; dbFile: string; backupsDir: string; attachmentsDir: string };

const inside = (dir: string, path: string) => !relative(resolve(dir), resolve(path)).startsWith("..") && resolve(dir) !== resolve(path);

// With measure off, sizes are left at 0. Cleanup only needs to know what is removable.
export async function storageReport(store: Store, paths: StoragePaths, measure = true): Promise<StorageReport> {
  const size = (path: string) => (measure ? sizeOf(path) : Promise.resolve(0));
  const claimed = new Set<string>();
  // Dot names a worktree folder after its task id, so that name is claimed while the task exists.
  const taskIds = new Set<string>();
  const worktrees: StorageReport["worktrees"] = [];
  for (const project of store.listProjects()) {
    for (const task of store.listTasks(project.id)) {
      taskIds.add(String(task.id));
      if (!task.worktreePath) continue;
      claimed.add(resolve(task.worktreePath));
      if (!existsSync(task.worktreePath)) continue;
      worktrees.push({
        taskId: task.id,
        number: task.number,
        title: task.title,
        projectName: project.name,
        column: task.column,
        bytes: await size(task.worktreePath),
        // A card dragged to Done by hand may never have merged. Uncommitted work would be lost.
        removable: task.column === "done" && !(await uncommittedChanges(task.worktreePath).catch(() => "")),
      });
    }
  }

  const orphans: StorageReport["orphans"] = [];
  if (existsSync(paths.worktreesDir)) {
    for (const name of await readdir(paths.worktreesDir)) {
      const path = resolve(paths.worktreesDir, name);
      if (claimed.has(path) || taskIds.has(name)) continue;
      const age = Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age >= ORPHAN_MIN_AGE_MS) orphans.push({ name, bytes: await size(path) });
    }
  }

  const other = [
    { label: "Database", bytes: (await size(paths.dbFile)) + (await size(`${paths.dbFile}-wal`)) },
    { label: "Database backups", bytes: await size(paths.backupsDir) },
    { label: "Attachments", bytes: await size(paths.attachmentsDir) },
  ];
  return { worktrees, orphans, other };
}

// Removes the worktrees of done tasks and the orphan folders. Returns how many folders went and how much space.
export async function cleanStorage(store: Store, paths: StoragePaths): Promise<{ removed: number; freedBytes: number }> {
  const report = await storageReport(store, paths, false);
  let removed = 0;
  let freedBytes = 0;

  for (const item of report.worktrees.filter((w) => w.removable)) {
    const task = store.getTask(item.taskId);
    if (!task.worktreePath || !inside(paths.worktreesDir, task.worktreePath)) continue;
    const project = store.getProject(task.projectId);
    const bytes = await sizeOf(task.worktreePath);
    await removeWorktree(project.repoPath, task.worktreePath);
    // git leaves ignored files such as node_modules behind in some cases.
    if (existsSync(task.worktreePath)) rmSync(task.worktreePath, { recursive: true, force: true });
    removed += 1;
    freedBytes += bytes;
  }
  for (const orphan of report.orphans) {
    const path = resolve(paths.worktreesDir, orphan.name);
    if (!inside(paths.worktreesDir, path)) continue;
    const bytes = await sizeOf(path);
    rmSync(path, { recursive: true, force: true });
    removed += 1;
    freedBytes += bytes;
  }
  // Forget the registrations of folders that are gone.
  for (const project of store.listProjects()) if (project.kind === "repo") await gitOk(project.repoPath, ["worktree", "prune"]);
  return { removed, freedBytes };
}
