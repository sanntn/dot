import assert from "node:assert/strict";
import { test } from "node:test";
import { ScheduleInputSchema } from "@dot/shared";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

function fixture() {
  const store = new Store(openDb(":memory:"));
  const make = (name: string) => store.createProject({ name, repoPath: `/tmp/${name}`, baseBranch: "main", browserTesting: false } as never);
  const a = make("alpha");
  const b = make("beta");
  const task = (projectId: number, title: string, kind: "code" | "report" | "triage", description = "") =>
    store.createTask({ projectId, title, description, kind, blockedBy: [] });
  const doc = (taskId: number, headline: string) =>
    store.addReportDoc(taskId, null, "agent", { headline, summary: `${headline} summary`, body: "b", sources: [], openQuestions: [] });
  return { store, a, b, task, doc };
}

test("documents lists report tasks with a document, newest first, and searches them", () => {
  const { store, a, b, task, doc } = fixture();
  const first = task(a.id, "Market scan", "report", "compare vendors");
  doc(first.id, "Three rivals");
  const second = task(b.id, "Pricing memo", "report");
  doc(second.id, "Prices rose");
  task(a.id, "No document yet", "report");
  const notReport = task(a.id, "A code change", "code", "compare vendors");
  store.moveTask(notReport.id, { column: "done", beforeTaskId: null });

  const all = store.listDocuments();
  assert.deepEqual(all.map((d) => d.task.title), ["Pricing memo", "Market scan"]);
  assert.equal(all[1]!.headline, "Three rivals");
  assert.equal(all[1]!.projectName, "alpha");
  assert.deepEqual(store.listDocuments({ projectId: b.id }).map((d) => d.task.title), ["Pricing memo"]);
  assert.deepEqual(store.listDocuments({ q: "compare" }).map((d) => d.task.title), ["Market scan"], "a code task never matches");
  assert.deepEqual(store.listDocuments({ q: "zzzz" }), []);
});

test("a newer version of a document uses the new headline", () => {
  const { store, a, task, doc } = fixture();
  const t = task(a.id, "Scan", "report");
  doc(t.id, "v1");
  doc(t.id, "v2");
  const [entry] = store.listDocuments();
  assert.deepEqual([entry!.version, entry!.headline], [2, "v2"]);
});

test("triage lists tasks waiting for review, with their proposals", () => {
  const { store, a, b, task } = fixture();
  const waiting = task(a.id, "Sort notes", "triage");
  store.addProposals(waiting.id, null, { headline: "Two tasks", summary: "s", items: [{ action: "create_task", title: "one", reason: "r" }] });
  store.moveTask(waiting.id, { column: "triage_review", beforeTaskId: null });
  const finished = task(b.id, "Old triage", "triage");
  store.addProposals(finished.id, null, { headline: "Done", summary: "s", items: [{ action: "create_task", title: "x", reason: "r" }] });
  store.moveTask(finished.id, { column: "done", beforeTaskId: null });
  const working = task(a.id, "Still reading", "triage");
  store.moveTask(working.id, { column: "research", beforeTaskId: null });

  assert.deepEqual(store.listTriage().map((e) => e.task.title), ["Sort notes"]);
  assert.equal(store.listTriage()[0]!.artifact.proposals.headline, "Two tasks");
  assert.deepEqual(store.listTriage({ projectId: b.id }), []);
});

test("the feed shows creations, gates, needs you and failures, not every move", () => {
  const { store, a, task } = fixture();
  const t = task(a.id, "Digest", "report");
  store.moveTask(t.id, { column: "research", beforeTaskId: null });
  store.moveTask(t.id, { column: "report_review", beforeTaskId: null });
  store.moveTask(t.id, { column: "done", beforeTaskId: null });
  store.setNeedsInput(t.id, true);
  const feed = store.listFeed();
  assert.deepEqual(feed.map((f) => `${f.event}:${f.detail}`).sort(), ["created:", "moved:done", "moved:report_review", "needs_you:"]);
  assert.ok(feed.every((f) => f.title === "Digest" && f.schedule === null));
});

test("a task's events keep their order even when they share a millisecond", () => {
  const { store, a, task } = fixture();
  const t = task(a.id, "Digest", "report");
  store.moveTask(t.id, { column: "report_review", beforeTaskId: null });
  store.moveTask(t.id, { column: "done", beforeTaskId: null });
  // Put every row of the task at one instant, so only the sequence decides the order.
  (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
    `UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z'; UPDATE task_events SET created_at = '2026-01-01T00:00:00.000Z'`,
  );
  assert.deepEqual(store.listFeed().map((f) => `${f.event}:${f.detail}`), ["moved:done", "moved:report_review", "created:"]);
});

test("the feed marks tasks a schedule made and can show only those", () => {
  const { store, a, task } = fixture();
  const scheduler = new Scheduler({ store, bus: new EventBus(), start: () => {} });
  const s = store.addSchedule(a.id, ScheduleInputSchema.parse({ name: "Monday digest", title: "Digest", kind: "report" }));
  scheduler.runNow(s.id);
  task(a.id, "By hand", "report");

  assert.equal(store.listFeed().length, 2);
  const scheduled = store.listFeed({ scheduledOnly: true });
  assert.deepEqual(scheduled.map((f) => [f.event, f.schedule]), [["created", "Monday digest"]]);
  assert.equal(store.listFeed({ projectId: a.id + 99 }).length, 0);
});

test("deleting a schedule keeps its tasks and clears the link", () => {
  const { store, a } = fixture();
  const scheduler = new Scheduler({ store, bus: new EventBus(), start: () => {} });
  const s = store.addSchedule(a.id, ScheduleInputSchema.parse({ name: "N", title: "T", kind: "report" }));
  scheduler.runNow(s.id);
  store.deleteSchedule(s.id);
  const [item] = store.listFeed({ scheduledOnly: false });
  assert.equal(item!.schedule, null);
  assert.equal(store.listFeed({ scheduledOnly: true }).length, 0);
});

test("the view routes answer and filter", async () => {
  const { store, a, task, doc } = fixture();
  doc(task(a.id, "Scan", "report").id, "Found it");
  const app = createApp(store, new EventBus(), {} as never, { attachmentsDir: "/tmp/a", reposDir: "/tmp/r", auth: new Auth(null, null, null) });
  const get = async (path: string) => {
    const res = await app.request(`/api${path}`, { headers: { host: "127.0.0.1" } });
    assert.equal(res.status, 200, path);
    return (await res.json()) as unknown[];
  };
  assert.equal((await get(`/documents?projectId=${a.id}&q=scan`)).length, 1);
  assert.equal((await get("/triage")).length, 0);
  assert.equal((await get("/feed?scheduled=1")).length, 0);
  assert.equal((await get("/feed")).length, 1);
});
