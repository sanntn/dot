import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMNS, DEFAULT_KIND, KINDS, TASK_KINDS, kindDef, laneOf, stageColumn, stageLabel, taskKindsFor } from "@dot/shared";

const card = (kind: string, column: string, extra: object = {}) =>
  ({ kind, column, needsInput: false, agentState: "idle", ...extra }) as Parameters<typeof laneOf>[0];

test("every kind only names columns that exist and that it lists itself", () => {
  for (const kind of TASK_KINDS) {
    const def = KINDS[kind];
    assert.equal(def.columns[0], "inbox", `${kind} starts in the inbox`);
    assert.equal(def.columns.at(-1), "done", `${kind} ends in done`);
    for (const c of [...def.columns, ...def.gates, ...def.startable, ...Object.keys(def.stepOf), ...Object.values(def.stageColumns)]) {
      assert.ok((COLUMNS as readonly string[]).includes(c), `${kind}: ${c} is a column`);
      assert.ok((def.columns as readonly string[]).includes(c), `${kind} lists ${c} in its columns`);
    }
    for (const step of Object.values(def.stepOf)) assert.ok(step! < def.steps.length, `${kind}: step index in range`);
  }
});

test("the lane of a card depends on its kind's gates", () => {
  assert.equal(laneOf(card("code", "plan_review")), "needs_you");
  assert.equal(laneOf(card("code", "report_review")), "working");
  assert.equal(laneOf(card("report", "report_review")), "needs_you");
  assert.equal(laneOf(card("report", "research")), "working");
  assert.equal(laneOf(card("report", "research", { needsInput: true })), "needs_you");
  assert.equal(laneOf(card("report", "research", { agentState: "failed" })), "needs_you");
  assert.equal(laneOf(card("report", "inbox")), "inbox");
  assert.equal(laneOf(card("report", "done")), "done");
});

test("a kind this build does not know reads as the default kind", () => {
  assert.equal(kindDef("hologram"), KINDS[DEFAULT_KIND]);
  assert.equal(laneOf(card("hologram", "plan_review")), "needs_you");
  assert.equal(stageColumn("hologram" as never, "execute"), "execute");
});

test("stages exist per kind, and the report agent has its own name", () => {
  assert.equal(stageColumn("report", "research"), "research");
  assert.equal(stageColumn("report", "execute"), null);
  assert.equal(stageLabel("report", "research"), "Report agent");
  assert.equal(stageLabel("code", "research"), "Researcher");
  assert.equal(stageLabel("report", "execute"), "Executor");
});

test("a workspace project offers every kind except code changes", () => {
  assert.deepEqual([...taskKindsFor("repo")], [...TASK_KINDS]);
  assert.ok(!taskKindsFor("workspace").includes("code"));
  assert.ok(taskKindsFor("workspace").includes("report"));
});
