import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTPUTS_LIMIT } from "@dot/shared";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { Store } from "../src/store.ts";

function fixture() {
  const store = new Store(openDb(":memory:"));
  const make = (name: string) => store.createProject({ name, repoPath: `/tmp/${name}`, baseBranch: "main", browserTesting: false } as never);
  const a = make("alpha");
  const b = make("beta");
  const done = (projectId: number, title: string, kind: "code" | "report" | "triage", description = "") => {
    const task = store.createTask({ projectId, title, description, kind, blockedBy: [] });
    store.moveTask(task.id, { column: "done", beforeTaskId: null });
    return task;
  };
  return { store, a, b, done };
}

test("only finished tasks are listed, newest first, with the last result", () => {
  const { store, a, done } = fixture();
  const report = done(a.id, "Market scan", "report");
  store.addReportDoc(report.id, null, "agent", { headline: "v1", summary: "old", body: "b", sources: [], openQuestions: [] });
  store.addReportDoc(report.id, null, "agent", { headline: "Three rivals matter", summary: "Short.", body: "b", sources: [], openQuestions: [] });
  const triage = done(a.id, "Sort notes", "triage");
  store.addProposals(triage.id, null, { headline: "Two tasks", summary: "s", items: [{ action: "create_task", title: "t", reason: "r" }] });
  const bare = done(a.id, "Dragged", "code");
  store.createTask({ projectId: a.id, title: "Still open", description: "", blockedBy: [] });

  const outputs = store.listOutputs();
  assert.deepEqual(outputs.map((o) => o.title), ["Dragged", "Sort notes", "Market scan"]);
  assert.equal(outputs[2]!.headline, "Three rivals matter");
  assert.equal(outputs[1]!.headline, "Accepted 0 of 1 proposed task. Two tasks");
  assert.equal(outputs[0]!.taskId, bare.id);
  assert.deepEqual([outputs[0]!.headline, outputs[0]!.url], ["", null], "a task with no result still lists");
});

test("it filters by project and kind, and rejects nothing it does not know", () => {
  const { store, a, b, done } = fixture();
  done(a.id, "One", "report");
  done(b.id, "Two", "report");
  done(b.id, "Three", "code");
  assert.deepEqual(store.listOutputs({ projectId: b.id }).map((o) => o.title).sort(), ["Three", "Two"]);
  assert.deepEqual(store.listOutputs({ kind: "report" }).map((o) => o.title).sort(), ["One", "Two"]);
  assert.deepEqual(store.listOutputs({ projectId: b.id, kind: "code" }).map((o) => o.title), ["Three"]);
  assert.equal(store.listOutputs({ projectId: b.id })[0]!.projectName, "beta");
});

test("search matches the text of finished tasks only", () => {
  const { store, a, done } = fixture();
  done(a.id, "Pricing review", "report", "compare vendor pricing");
  done(a.id, "Other", "report", "nothing relevant");
  store.createTask({ projectId: a.id, title: "Pricing open", description: "", blockedBy: [] });
  assert.deepEqual(store.listOutputs({ q: "pricin" }).map((o) => o.title), ["Pricing review"]);
  assert.deepEqual(store.listOutputs({ q: "zzzz" }), []);
  assert.equal(store.listOutputs({ q: "   " }).length, 2, "blank search lists everything");
});

test("search finds a finished task even when many open tasks rank higher", () => {
  const { store, a, done } = fixture();
  for (let i = 0; i < 250; i++) store.createTask({ projectId: a.id, title: "pricing pricing pricing", description: "pricing", blockedBy: [] });
  done(a.id, "Vendor scan", "report", `${"filler words ".repeat(200)} pricing`);
  assert.deepEqual(store.listOutputs({ q: "pricing" }).map((o) => o.title), ["Vendor scan"]);
});

test("search and a project filter combine", () => {
  const { store, a, b, done } = fixture();
  done(a.id, "Alpha pricing", "report");
  done(b.id, "Beta pricing", "report");
  assert.deepEqual(store.listOutputs({ q: "pricing", projectId: b.id }).map((o) => o.title), ["Beta pricing"]);
});

test("the list stops at the limit", () => {
  const { store, a, done } = fixture();
  for (let i = 0; i < OUTPUTS_LIMIT + 5; i++) done(a.id, `Task ${i}`, "report");
  assert.equal(store.listOutputs().length, OUTPUTS_LIMIT);
});

test("a triage row says what was accepted", () => {
  const { store, a, done } = fixture();
  const triage = done(a.id, "Sort", "triage");
  const items = [
    { action: "create_task" as const, title: "one", reason: "r" },
    { action: "create_task" as const, title: "two", reason: "r" },
    { action: "drop" as const, title: "noise", reason: "r" },
  ];
  store.addProposals(triage.id, null, { headline: "Two tasks and one drop.", summary: "s", items });
  store.addProposalDecisions(triage.id, 1, { 0: { status: "accepted", taskId: null }, 1: { status: "rejected", taskId: null } });
  assert.equal(store.listOutputs()[0]!.headline, "Accepted 1 of 2 proposed tasks. Two tasks and one drop.");
});

test("a task finished twice shows the latest finish time", () => {
  const { store, a, done } = fixture();
  const task = done(a.id, "Again", "report");
  store.moveTask(task.id, { column: "inbox", beforeTaskId: null });
  store.moveTask(task.id, { column: "done", beforeTaskId: null });
  const finishes = store.listEvents(task.id).filter((e) => e.kind === "moved" && e.detail === "done");
  assert.equal(finishes.length, 2);
  assert.equal(store.listOutputs()[0]!.finishedAt, finishes.at(-1)!.createdAt);
});

test("the route filters and refuses an unknown kind", async () => {
  const { store, a, done } = fixture();
  done(a.id, "Scan", "report");
  const app = createApp(store, new EventBus(), {} as never, { attachmentsDir: "/tmp/a", reposDir: "/tmp/r", auth: new Auth(null, null, null) });
  const get = (path: string) => app.request(`/api${path}`, { headers: { host: "127.0.0.1" } });
  const ok = await get(`/outputs?kind=report&projectId=${a.id}&q=scan`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as unknown[]).length, 1);
  assert.equal((await get("/outputs?kind=nope")).status, 400);
});
