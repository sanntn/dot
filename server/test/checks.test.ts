import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@dot/shared";
import { checksSummary, runChecks } from "../src/checks.ts";

const project = (testCommand: string) => ({ testCommand, lintCommand: null, typecheckCommand: null }) as Project;
// A command that never ends, started through the shell so a grandchild holds the output pipes.
const forever = `node -e "setInterval(() => {}, 1000)"`;

test("a passing and a failing command are told apart", async () => {
  const ok = await runChecks(project(`node -e "process.exit(0)"`), process.cwd());
  assert.equal(ok[0]!.ok, true);
  const bad = await runChecks(project(`node -e "console.log('boom'); process.exit(3)"`), process.cwd());
  assert.equal(bad[0]!.ok, false);
  assert.equal(bad[0]!.exitCode, 3);
  assert.match(checksSummary(bad), /boom/);
});

test("a command that outlives its timeout is killed and the run finishes", async () => {
  const started = Date.now();
  const results = await runChecks(project(forever), process.cwd(), 400);
  assert.equal(results[0]!.timedOut, true);
  assert.equal(results[0]!.ok, false);
  assert.ok(Date.now() - started < 5000, "the run should not wait for the pipes of a killed command");
});

test("aborting stops a running command", async () => {
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 300);
  const started = Date.now();
  await runChecks(project(forever), process.cwd(), 60_000, abort.signal);
  assert.ok(Date.now() - started < 5000);
});
