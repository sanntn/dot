import assert from "node:assert/strict";
import { test } from "node:test";
import { guardRules } from "../src/agents/guards.ts";

const rules = guardRules({
  port: 4317,
  root: String.raw`D:\Stuff\Dot`,
  dataDir: String.raw`D:\Stuff\Dot\data`,
  dbFile: String.raw`D:\Stuff\Dot\data\dot.db`,
});

test("blocks every loopback spelling of Dot's own port", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]) {
    assert.ok(rules.includes(`Bash(*${host}:4317*)`), host);
  }
});

test("blocks the .env file in native, forward-slash and Git Bash spellings", () => {
  assert.ok(rules.includes(String.raw`Bash(*D:\Stuff\Dot\.env*)`));
  assert.ok(rules.includes("Bash(*D:/Stuff/Dot/.env*)"));
  assert.ok(rules.includes("Bash(*/d/Stuff/Dot/.env*)"));
});

test("protects the database and attachments but not the worktrees", () => {
  assert.ok(rules.some((r) => r.includes("dot.db")));
  assert.ok(rules.some((r) => r.includes("attachments")));
  assert.ok(!rules.some((r) => r.endsWith("/data*)") || r.endsWith("\data*)")));
});

test("blocks environment dumps", () => {
  for (const rule of ["Bash(printenv*)", "Bash(env)", "Bash(*/proc/self/environ*)"]) assert.ok(rules.includes(rule), rule);
});

test("has no duplicate rules", () => {
  assert.equal(new Set(rules).size, rules.length);
});
