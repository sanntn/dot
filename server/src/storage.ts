import { existsSync, rmSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { StorageReport } from "@dot/shared";
import { gitOk, removeWorktree, uncommittedChanges } from "./git.ts";
import type { Store } from "./store.ts";

// What Dot keeps on disk, and cleanup of the part that is safe to delete: worktrees of finished tasks and
// folders in the worktrees directory that no task owns. A worktree of an open task may hold uncommitted
// work, so it is listed but never removed here.

// Total size of a file or folder. Symbolic links count as themselves and are not followed.
export async function sizeOf(path: string): Promise<number> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  for (let i = 0; i < names.length; i += 16) {
    const sizes = await Promise.all(names.slice(i, i + 16).map((name) => sizeOf(join(path, name))));
    total += sizes.reduce((a, b) => a + b, 0);
  }
  return total;
}

// A folder this young may belong to a worktree being created right now, before its task records the path.
const ORPHAN_MIN_AGE_MS = 60 * 60_000;

export type StoragePaths = { worktreesDir: string; dbFile: string; backupsDir: string; attachmentsDir: string };

const inside = (dir: string, path: string) => !relative(resolve(dir), resolve(path)).startsWith("..") && resolve(dir) !== resolve(path);

export async function storageReport(store: Store, paths: StoragePaths): Promise<StorageReport> {
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
        bytes: await sizeOf(task.worktreePath),
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
      if (age >= ORPHAN_MIN_AGE_MS) orphans.push({ name, bytes: await sizeOf(path) });
    }
  }

  const other = [
    { label: "Database", bytes: (await sizeOf(paths.dbFile)) + (await sizeOf(`${paths.dbFile}-wal`)) },
    { label: "Database backups", bytes: await sizeOf(paths.backupsDir) },
    { label: "Attachments", bytes: await sizeOf(paths.attachmentsDir) },
  ];
  return { worktrees, orphans, other };
}

// Removes the worktrees of done tasks and the orphan folders. Returns how many folders went and how much space.
export async function cleanStorage(store: Store, paths: StoragePaths): Promise<{ removed: number; freedBytes: number }> {
  const report = await storageReport(store, paths);
  let removed = 0;
  let freedBytes = 0;

  for (const item of report.worktrees.filter((w) => w.removable)) {
    const task = store.getTask(item.taskId);
    if (!task.worktreePath || !inside(paths.worktreesDir, task.worktreePath)) continue;
    const project = store.getProject(task.projectId);
    await removeWorktree(project.repoPath, task.worktreePath);
    // git leaves ignored files such as node_modules behind in some cases.
    if (existsSync(task.worktreePath)) rmSync(task.worktreePath, { recursive: true, force: true });
    removed += 1;
    freedBytes += item.bytes;
  }
  for (const orphan of report.orphans) {
    const path = resolve(paths.worktreesDir, orphan.name);
    if (!inside(paths.worktreesDir, path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
    freedBytes += orphan.bytes;
  }
  // Forget the registrations of folders that are gone.
  for (const project of store.listProjects()) await gitOk(project.repoPath, ["worktree", "prune"]);
  return { removed, freedBytes };
}
