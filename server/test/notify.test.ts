import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectInputSchema } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { startNotifier } from "../src/notify.ts";
import { Store } from "../src/store.ts";

type Call = { url: string; init: RequestInit };

function setup(options: { format?: "json" | "text"; appUrl?: string; status?: number } = {}) {
  const store = new Store(openDb(":memory:"));
  const bus = new EventBus();
  const project = store.createProject(ProjectInputSchema.parse({ name: "Shop", repoPath: "/tmp/none", baseBranch: "main" }));
  const calls: Call[] = [];
  const logs: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
  const task = (title: string) => store.createTask({ projectId: project.id, title, description: "", blockedBy: [] });
  const changed = () => bus.publish({ type: "tasks.changed", projectId: project.id });
  const stop = () => stopper();
  let stopper = () => {};
  const start = () => {
    stopper = startNotifier(store, bus, { url: "https://hook.test/x", settleMs: 10, fetch: fake, ...options }, (m) => logs.push(m));
  };
  return { store, project, calls, logs, task, changed, start, stop };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("sends one JSON message when a task starts waiting on a question", async () => {
  const s = setup({ appUrl: "http://dot.test/" });
  const t = s.task("Add a cart page");
  s.store.moveTask(t.id, { column: "research", beforeTaskId: null });
  s.start();
  s.store.addMessage({ taskId: t.id, runId: null, role: "agent", kind: "question", text: "Which payment provider?", data: null });
  s.store.setNeedsInput(t.id, true);
  s.changed();
  s.changed();
  await settle();
  s.stop();

  assert.equal(s.calls.length, 1);
  const body = JSON.parse(String(s.calls[0]!.init.body));
  assert.equal(body.event, "needs_you");
  assert.equal(body.task.id, t.id);
  assert.match(body.text, /Shop #1 needs you/);
  assert.match(body.text, /Which payment provider\?/);
  assert.equal(body.url, `http://dot.test/?project=${s.project.id}&task=${t.id}`);
});

test("tasks already waiting at startup stay quiet, and a plan to review notifies", async () => {
  const s = setup();
  const old = s.task("Old");
  s.store.moveTask(old.id, { column: "plan_review", beforeTaskId: null });
  s.start();
  const fresh = s.task("Fresh");
  s.store.moveTask(fresh.id, { column: "plan_review", beforeTaskId: null });
  s.changed();
  await settle();
  s.stop();

  assert.equal(s.calls.length, 1);
  assert.match(String(s.calls[0]!.init.body), /Fresh/);
  assert.match(String(s.calls[0]!.init.body), /plan is ready/);
});

test("a task that stops waiting before the delay sends nothing, and one that returns sends again", async () => {
  const s = setup();
  const t = s.task("Flicker");
  s.start();
  s.store.moveTask(t.id, { column: "plan_review", beforeTaskId: null });
  s.changed();
  s.store.moveTask(t.id, { column: "execute", beforeTaskId: null });
  s.changed();
  await settle();
  assert.equal(s.calls.length, 0);

  s.store.moveTask(t.id, { column: "merge_approval", beforeTaskId: null });
  s.changed();
  await settle();
  s.stop();
  assert.equal(s.calls.length, 1);
  assert.match(String(s.calls[0]!.init.body), /ready to merge/);
});

test("text format puts the title in a header and the message in the body", async () => {
  const s = setup({ format: "text" });
  const t = s.task("Fix login");
  s.start();
  s.store.moveTask(t.id, { column: "plan_review", beforeTaskId: null });
  s.changed();
  await settle();
  s.stop();

  const headers = s.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Title, "Shop #1 needs you");
  assert.match(String(s.calls[0]!.init.body), /^Fix login\n/);
});

test("a webhook that answers with an error is logged, not thrown", async () => {
  const s = setup({ status: 500 });
  const t = s.task("Broken hook");
  s.start();
  s.store.moveTask(t.id, { column: "plan_review", beforeTaskId: null });
  s.changed();
  await settle();
  s.stop();
  assert.deepEqual(s.logs, ["Notification webhook answered 500."]);
});
