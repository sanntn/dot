import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectInputSchema } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { toMatchQuery } from "../src/search.ts";
import { Store } from "../src/store.ts";

function setup() {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject(ProjectInputSchema.parse({ name: "Shop", repoPath: "/tmp/none", baseBranch: "main" }));
  const task = (title: string, description = "") => store.createTask({ projectId: project.id, title, description, blockedBy: [] });
  return { store, project, task };
}

test("words in a query are quoted, and the last one matches as a prefix", () => {
  assert.equal(toMatchQuery("cart OR page"), '"cart" "OR" "page"*');
  assert.equal(toMatchQuery('  "NEAR(x" -- '), '"NEAR" "x"*');
  assert.equal(toMatchQuery("***"), null);
});

test("finds a task by its title, its description and its chat, and shows each task once", () => {
  const s = setup();
  const cart = s.task("Add a cart page", "Shoppers need a basket.");
  const login = s.task("Fix login", "Sessions expire too early.");
  s.store.addMessage({ taskId: login.id, runId: null, role: "agent", kind: "question", text: "Should the basket survive a logout?", data: null });
  s.store.addMessage({ taskId: login.id, runId: null, role: "agent", kind: "tool", text: "basket secret tool output", data: null });

  assert.deepEqual(s.store.search("cart").map((h) => [h.taskId, h.kind]), [[cart.id, "task"]]);
  // Both tasks mention a basket. The tool message does not count as a match.
  const basket = s.store.search("basket");
  assert.deepEqual(basket.map((h) => h.taskId).sort(), [cart.id, login.id].sort());
  assert.equal(s.store.search("secret").length, 0);
  // Prefix matching while typing.
  assert.equal(s.store.search("expi")[0]?.taskId, login.id);
  assert.match(s.store.search("expire")[0]!.snippet, /\u0001Sessions expire\u0002|\u0001expire\u0002/);
});

test("finds words inside plans, and an edit or a delete updates the index", () => {
  const s = setup();
  const t = s.task("Speed up the pipeline");
  s.store.addPlan(t.id, null, "agent", {
    headline: "Cache the compiler output",
    summary: "Compiler runs dominate.",
    steps: [{ title: "Turn on incremental mode", detail: "Set the flag." }],
    acceptanceCriteria: ["Warm builds take under ten seconds"],
    risks: [],
    assumptions: [],
  } as never);

  assert.equal(s.store.search("incremental")[0]?.kind, "plan");
  // JSON keys are not text.
  assert.equal(s.store.search("acceptanceCriteria").length, 0);

  s.store.updateTask(t.id, { title: "Speed up the bundler" });
  assert.equal(s.store.search("bundler").length, 1);
  assert.equal(s.store.search("pipeline").length, 0);

  s.store.addMessage({ taskId: t.id, runId: null, role: "agent", kind: "text", text: "Remember the zebra flag.", data: null });
  assert.equal(s.store.search("zebra").length, 1);

  s.store.deleteTask(t.id);
  assert.equal(s.store.search("zebra").length, 0);
  assert.equal(s.store.search("incremental").length, 0);
  assert.equal(s.store.search("bundler").length, 0);
});

test("a search can be limited to one project", () => {
  const s = setup();
  const other = s.store.createProject(ProjectInputSchema.parse({ name: "Blog", repoPath: "/tmp/none2", baseBranch: "main" }));
  s.task("Shared word: invoices");
  s.store.createTask({ projectId: other.id, title: "More invoices", description: "", blockedBy: [] });
  assert.equal(s.store.search("invoices").length, 2);
  assert.equal(s.store.search("invoices", { projectId: other.id }).length, 1);
});

test("finds words inside a report's body and sources", () => {
  const s = setup();
  const t = s.store.createTask({ projectId: s.project.id, title: "Compare hosts", description: "", kind: "report", blockedBy: [] });
  s.store.addReportDoc(t.id, null, "agent", {
    headline: "Host A wins on price.",
    summary: "Short.",
    body: "## Findings\n\nThe vendor offers a nonprofit discount.",
    sources: [{ title: "Quarterly pricing sheet", url: "https://example.com/p" }],
    openQuestions: [],
  });
  const hits = s.store.search("nonprofit");
  assert.deepEqual(hits.map((h) => [h.taskId, h.kind]), [[t.id, "document"]]);
  assert.equal(s.store.search("quarterly")[0]?.taskId, t.id);
});
