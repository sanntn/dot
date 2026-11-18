import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectInputSchema } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";

function fixture() {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  const task = (title: string) => store.createTask({ projectId: project.id, title, description: "", blockedBy: [] });
  return { store, project, task };
}

test("new tasks land in the inbox", () => {
  const { task } = fixture();
  assert.equal(task("one").column, "inbox");
});

test("moveTask puts a card before another and renumbers the column", () => {
  const { store, task } = fixture();
  const [a, b, c] = [task("a"), task("b"), task("c")];
  for (const t of [a, b, c]) store.moveTask(t.id, { column: "research", beforeTaskId: null });
  store.moveTask(c.id, { column: "research", beforeTaskId: a.id });
  const order = store.listTasks(a.projectId).filter((t) => t.column === "research").sort((x, y) => x.position - y.position).map((t) => t.title);
  assert.deepEqual(order, ["c", "a", "b"]);
});

test("moveTask rejects a beforeTaskId from another column", () => {
  const { store, task } = fixture();
  const [a, b] = [task("a"), task("b")];
  store.moveTask(a.id, { column: "research", beforeTaskId: null });
  assert.throws(() => store.moveTask(b.id, { column: "done", beforeTaskId: a.id }));
});

test("moving between columns logs an event", () => {
  const { store, task } = fixture();
  const t = task("a");
  store.moveTask(t.id, { column: "research", beforeTaskId: null });
  assert.ok(store.listEvents(t.id).some((e) => e.kind === "moved" && e.detail === "research"));
});

test("a rule you write brings back a removed one, and the reviewer's suggestion of it stays hidden", () => {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject(ProjectInputSchema.parse({ name: "P", repoPath: "/tmp/none", baseBranch: "main" }));
  const task = store.createTask({ projectId: project.id, title: "T", description: "", blockedBy: [] });
  const first = store.addRule(project.id, "Use the api client.", "active")!;
  store.deleteRule(first.id);
  assert.equal(store.addRule(project.id, "use the api  client.", "suggested", task.id), null);
  assert.equal(store.listRules(project.id).length, 0);

  const back = store.addRule(project.id, "Use the api client.", "active");
  assert.equal(back?.status, "active");
  assert.equal(back?.id, first.id);
  assert.equal(store.addRule(project.id, "Use the api client.", "active"), null);

  const suggested = store.addRule(project.id, "Name hooks useThing.", "suggested", task.id)!;
  assert.equal(store.addRule(project.id, "Name hooks useThing.", "active")?.id, suggested.id);
});
