import assert from "node:assert/strict";
import { test } from "node:test";
import { guardRules, sandboxSettings } from "../src/agents/guards.ts";

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

test("denies the file tools on private paths too, for a file and for a folder", () => {
  // The CLI takes the Git Bash form (//d/...) and the drive form (D:/...) on Windows. Both were checked against it.
  assert.ok(rules.includes("Read(//d/Stuff/Dot/.env)"));
  assert.ok(rules.includes("Read(D:/Stuff/Dot/.env)"));
  assert.ok(rules.includes("Read(//d/Stuff/Dot/data/attachments/**)"));
  assert.ok(!rules.some((r) => r.startsWith("Read(") && r.includes("/data)")), "the worktrees folder stays readable");
});

test("secret files are guarded like .env, and POSIX paths use a double slash", () => {
  const withSecrets = guardRules({
    port: 4317,
    root: "/srv/dot",
    dataDir: "/srv/dot/data",
    dbFile: "/srv/dot/data/dot.db",
    secretFiles: ["/home/me/.dot/github-token"],
  });
  assert.ok(withSecrets.includes("Bash(*/home/me/.dot/github-token*)"));
  assert.ok(withSecrets.includes("Read(//home/me/.dot/github-token)"));
  assert.ok(withSecrets.includes("Read(//srv/dot/.env)"));
});

test("the sandbox denies the same private paths and refuses to run unsandboxed", () => {
  const settings = sandboxSettings({ port: 4317, root: "/srv/dot", dataDir: "/srv/dot/data", dbFile: "/srv/dot/data/dot.db", secretFiles: ["/run/secrets/gh"] });
  assert.equal(settings.failIfUnavailable, true);
  assert.equal(settings.allowUnsandboxedCommands, false);
  assert.ok(settings.filesystem.denyRead.includes("/srv/dot/.env"));
  assert.ok(settings.filesystem.denyRead.includes("/run/secrets/gh"));
  assert.ok(!settings.filesystem.denyRead.includes("/srv/dot/data"));
});
