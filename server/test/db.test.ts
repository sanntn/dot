import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MIGRATIONS, openDb } from "../src/db.ts";

test("a database from before task kinds opens, and its tasks become code changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-db-"));
  try {
    const file = join(dir, "old.db");
    // Build the database as the build before kinds left it: every migration but the kind ones.
    const kindMigration = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN kind"));
    assert.ok(kindMigration > 0, "the kind migration exists");
    const old = new DatabaseSync(file);
    old.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < kindMigration; i++) {
      old.exec(MIGRATIONS[i]!);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    const now = new Date().toISOString();
    old.prepare("INSERT INTO projects (name, repo_path, base_branch, created_at, updated_at) VALUES ('P', '/tmp/p', 'main', ?, ?)").run(now, now);
    old
      .prepare("INSERT INTO tasks (project_id, number, title, description, column_key, position, created_at, updated_at) VALUES (1, 1, 'Old task', '', 'research', 1024, ?, ?)")
      .run(now, now);
    old.close();

    const db = openDb(file);
    const row = db.prepare("SELECT kind, column_key FROM tasks WHERE title = 'Old task'").get() as { kind: string; column_key: string };
    assert.deepEqual({ ...row }, { kind: "code", column_key: "research" });
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
