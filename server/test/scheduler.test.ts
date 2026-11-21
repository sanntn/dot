import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRun, ScheduleInputSchema, SchedulePatchSchema } from "@dot/shared";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

function fixture(projectKind: "repo" | "workspace" = "repo") {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false, kind: projectKind } as never);
  const started: number[] = [];
  const scheduler = new Scheduler({ store, bus: new EventBus(), start: (id) => void started.push(id) });
  const add = (input: object) => store.addSchedule(project.id, ScheduleInputSchema.parse({ name: "Digest", title: "Digest", kind: "report", ...input }));
  return { store, project, scheduler, started, add };
}

const at = (iso: string) => new Date(iso);
// Local-time constructor, so the tests do not depend on the machine's time zone.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("nextRun: daily picks today if the time is ahead, else tomorrow", () => {
  const rhythm = { frequency: "daily", hour: 9, minute: 30, weekday: 1 } as const;
  assert.deepEqual(nextRun(rhythm, local(2026, 11, 21, 8, 0)), local(2026, 11, 21, 9, 30));
  assert.deepEqual(nextRun(rhythm, local(2026, 11, 21, 9, 30)), local(2026, 11, 22, 9, 30));
  assert.deepEqual(nextRun(rhythm, local(2026, 11, 30, 10, 0)), local(2026, 12, 1, 9, 30));
});

test("nextRun: hourly keeps the minute", () => {
  const rhythm = { frequency: "hourly", hour: 0, minute: 15, weekday: 1 } as const;
  assert.deepEqual(nextRun(rhythm, local(2026, 11, 21, 8, 10)), local(2026, 11, 21, 8, 15));
  assert.deepEqual(nextRun(rhythm, local(2026, 11, 21, 8, 15)), local(2026, 11, 21, 9, 15));
  assert.deepEqual(nextRun(rhythm, local(2026, 11, 21, 23, 45)), local(2026, 11, 22, 0, 15));
});

test("nextRun: weekly lands on the weekday, never in the past", () => {
  // 2026-11-21 is a Saturday (6). Monday is 1.
  const monday = { frequency: "weekly", hour: 9, minute: 0, weekday: 1 } as const;
  assert.deepEqual(nextRun(monday, local(2026, 11, 21, 12, 0)), local(2026, 11, 23, 9, 0));
  const saturday = { frequency: "weekly", hour: 9, minute: 0, weekday: 6 } as const;
  assert.deepEqual(nextRun(saturday, local(2026, 11, 21, 8, 0)), local(2026, 11, 21, 9, 0));
  assert.deepEqual(nextRun(saturday, local(2026, 11, 21, 9, 0)), local(2026, 11, 28, 9, 0));
});

test("a due schedule makes a task, starts it and plans the next firing", () => {
  const { store, scheduler, started, add } = fixture();
  const s = add({ description: "Summarise the week." });
  assert.ok(s.nextRunAt);
  const later = new Date(new Date(s.nextRunAt).getTime() + 1000);

  const made = scheduler.tick(later);
  assert.equal(made.length, 1);
  assert.equal(made[0]!.kind, "report");
  assert.equal(made[0]!.description, "Summarise the week.");
  assert.match(made[0]!.title, /^Digest \(\d{4}-\d{2}-\d{2}\)$/);
  assert.deepEqual(started, [made[0]!.id]);

  const after = store.getSchedule(s.id);
  assert.equal(after.lastTaskId, made[0]!.id);
  assert.ok(after.nextRunAt && new Date(after.nextRunAt) > later);
  assert.deepEqual(scheduler.tick(later), [], "nothing is due again");
});

test("a schedule that is not due, or is off, makes nothing", () => {
  const { store, scheduler, add } = fixture();
  const on = add({});
  const off = add({ name: "Off", enabled: false });
  assert.equal(off.nextRunAt, null);
  assert.deepEqual(scheduler.tick(new Date(Date.parse(on.nextRunAt!) - 60_000)), []);
  assert.deepEqual(scheduler.tick(at("2100-01-01T00:00:00Z")).map((t) => t.title.startsWith("Digest")), [true]);
  assert.equal(store.getSchedule(off.id).lastRunAt, null);
});

test("it skips while the last task is open and fires again once it is done", () => {
  const { store, scheduler, add } = fixture();
  const s = add({});
  const first = scheduler.tick(new Date(Date.parse(s.nextRunAt!) + 1000))[0]!;

  const second = store.getSchedule(s.id);
  const skipped = scheduler.tick(new Date(Date.parse(second.nextRunAt!) + 1000));
  assert.deepEqual(skipped, []);
  assert.match(store.getSchedule(s.id).lastNote, /Skipped/);
  assert.equal(store.listTasks(s.projectId).length, 1);

  store.moveTask(first.id, { column: "done", beforeTaskId: null });
  const third = store.getSchedule(s.id);
  assert.equal(scheduler.tick(new Date(Date.parse(third.nextRunAt!) + 1000)).length, 1);
});

test("a deleted last task does not block the schedule", () => {
  const { store, scheduler, add } = fixture();
  const s = add({});
  const first = scheduler.tick(new Date(Date.parse(s.nextRunAt!) + 1000))[0]!;
  store.deleteTask(first.id);
  assert.equal(store.getSchedule(s.id).lastTaskId, null);
  const next = store.getSchedule(s.id);
  assert.equal(scheduler.tick(new Date(Date.parse(next.nextRunAt!) + 1000)).length, 1);
});

test("a start that fails still keeps the task and says why", () => {
  const { store, project, add } = fixture();
  const failing = new Scheduler({ store, bus: new EventBus(), start: () => { throw new Error("no folder"); } });
  const s = add({});
  const [task] = failing.tick(new Date(Date.parse(s.nextRunAt!) + 1000));
  assert.ok(task);
  assert.match(store.getSchedule(s.id).lastNote, /did not start: no folder/);
  assert.equal(store.listTasks(project.id).length, 1);
});

test("run now makes a task even while the last one is open, and keeps the planned time", () => {
  const { store, scheduler, add } = fixture();
  const s = add({});
  scheduler.runNow(s.id);
  scheduler.runNow(s.id);
  assert.equal(store.listTasks(s.projectId).length, 2);
  assert.equal(store.getSchedule(s.id).nextRunAt, s.nextRunAt);
});

test("switching a schedule on or changing its rhythm plans from now", () => {
  const { store, add } = fixture();
  const s = add({ enabled: false });
  const on = store.updateSchedule(s.id, { enabled: true });
  assert.ok(on.nextRunAt);
  const renamed = store.updateSchedule(s.id, { name: "Other" });
  assert.equal(renamed.nextRunAt, on.nextRunAt, "a rename keeps the plan");
  assert.equal(store.updateSchedule(s.id, { enabled: false }).nextRunAt, null);
});

test("a patch of one field leaves the others alone", () => {
  const patch = SchedulePatchSchema.parse({ enabled: false });
  assert.deepEqual(patch, { enabled: false });
  const { store, add } = fixture();
  const s = add({ frequency: "weekly", hour: 7, minute: 5, weekday: 3 });
  const off = store.updateSchedule(s.id, patch);
  assert.deepEqual([off.frequency, off.hour, off.minute, off.weekday], ["weekly", 7, 5, 3]);
  assert.throws(() => SchedulePatchSchema.parse({}));
});

test("nextRun is always after the start and within one period, across a year", () => {
  const rhythms = [
    { frequency: "hourly", hour: 0, minute: 30, weekday: 0 },
    { frequency: "daily", hour: 2, minute: 30, weekday: 0 },
    { frequency: "weekly", hour: 2, minute: 30, weekday: 0 },
  ] as const;
  const limit = { hourly: 2, daily: 26, weekly: 24 * 7 + 2 };
  for (const rhythm of rhythms) {
    for (let from = local(2026, 1, 1).getTime(); from < local(2027, 1, 1).getTime(); from += 6 * 3600_000) {
      const next = nextRun(rhythm, new Date(from)).getTime();
      assert.ok(next > from, `${rhythm.frequency} after ${new Date(from).toISOString()}`);
      assert.ok(next - from <= limit[rhythm.frequency] * 3600_000, `${rhythm.frequency} soon after ${new Date(from).toISOString()}`);
    }
  }
});

test("the schedule routes create, patch, run and delete", async () => {
  const { store, project, started } = fixture();
  const scheduler = new Scheduler({ store, bus: new EventBus(), start: (id) => void started.push(id) });
  const app = createApp(store, new EventBus(), {} as never, { attachmentsDir: "/tmp/a", reposDir: "/tmp/r", scheduler, auth: new Auth(null, null, null) });
  const call = (path: string, method: string, body?: object) =>
    app.request(`/api${path}`, { method, headers: { "content-type": "application/json", host: "127.0.0.1" }, body: body && JSON.stringify(body) });

  const created = await call(`/projects/${project.id}/schedules`, "POST", { name: "W", title: "Weekly", kind: "report", frequency: "weekly", hour: 7, minute: 5, weekday: 3 });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: number };
  assert.equal((await call(`/projects/${project.id}/schedules`, "POST", { name: "", title: "x" })).status, 400);

  const patched = (await (await call(`/schedules/${id}`, "PATCH", { enabled: false })).json()) as Record<string, unknown>;
  assert.deepEqual([patched.enabled, patched.frequency, patched.hour, patched.minute, patched.weekday], [false, "weekly", 7, 5, 3]);
  assert.equal((await call(`/schedules/${id}`, "PATCH", {})).status, 400);

  assert.equal((await call(`/schedules/${id}/run`, "POST")).status, 201);
  assert.equal(started.length, 1);

  assert.equal((await call(`/schedules/${id}`, "DELETE")).status, 204);
  assert.equal((await call(`/schedules/${id}`, "DELETE")).status, 404);
});

test("a schedule that came due while Dot was off fires once, not once per missed run", () => {
  const { scheduler, store, add } = fixture();
  const s = add({ frequency: "hourly" });
  const weekLater = new Date(Date.parse(s.nextRunAt!) + 7 * 24 * 3600_000);
  assert.equal(scheduler.tick(weekLater).length, 1);
  assert.equal(scheduler.tick(weekLater).length, 0);
  assert.ok(new Date(store.getSchedule(s.id).nextRunAt!) > weekLater);
});

test("a workspace schedule cannot make code tasks", () => {
  const { store, project } = fixture("workspace");
  assert.throws(() => store.addSchedule(project.id, ScheduleInputSchema.parse({ name: "x", title: "x", kind: "code" })), /cannot hold/);
});
