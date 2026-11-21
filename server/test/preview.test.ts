import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_MEMORY_NOTES, MAX_PENDING_MEMORY, planSubtaskProblem, type Plan } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { findBrowser, previewUrl } from "../src/preview.ts";
import { Store } from "../src/store.ts";

test("a preview address must be on this machine", () => {
  assert.equal(previewUrl("http://localhost:5173")?.href, "http://localhost:5173/");
  assert.equal(previewUrl("http://127.0.0.1:3000/app")?.pathname, "/app");
  assert.equal(previewUrl("http://app.localhost:8080")?.hostname, "app.localhost");
  assert.equal(previewUrl("https://example.com"), null);
  assert.equal(previewUrl("http://localhost.evil.com"), null);
  assert.equal(previewUrl("file:///etc/passwd"), null);
  assert.equal(previewUrl("not a url"), null);
  assert.equal(previewUrl(null), null);
});

test("DOT_BROWSER_BIN names the browser, and a wrong path finds none", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-browser-"));
  const file = join(dir, "browser");
  writeFileSync(file, "");
  assert.equal(findBrowser({ DOT_BROWSER_BIN: file }), file);
  assert.equal(findBrowser({ DOT_BROWSER_BIN: join(dir, "missing") }), null);
});

const base: Plan = {
  headline: "h",
  goal: "g",
  context: "",
  acceptanceCriteria: ["c"],
  filesToTouch: [],
  steps: ["a", "b", "c"],
  testPlan: "",
  risks: [],
  assumptions: [],
};

test("suggested subtasks are checked before they are applied", () => {
  assert.equal(planSubtaskProblem(base), null);
  const ok = [
    { title: "A", steps: [0], dependsOn: [] },
    { title: "B", steps: [1, 2], dependsOn: [0] },
  ];
  assert.equal(planSubtaskProblem({ ...base, subtasks: ok }), null);
  assert.match(planSubtaskProblem({ ...base, subtasks: ok.slice(0, 1) }) ?? "", /at least two/);
  assert.match(planSubtaskProblem({ ...base, subtasks: [ok[0]!, { title: "B", steps: [1], dependsOn: [] }] }) ?? "", /Step 3 is in no task/);
  assert.match(planSubtaskProblem({ ...base, subtasks: [ok[0]!, { title: "B", steps: [9], dependsOn: [] }] }) ?? "", /does not have/);
  assert.match(planSubtaskProblem({ ...base, subtasks: [{ ...ok[0]!, dependsOn: [1] }, ok[1]!] }) ?? "", /earlier task/);
});

test("suggestions have their own limit, and a dismissed one is not suggested again", () => {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  for (let i = 0; i < MAX_PENDING_MEMORY; i++) store.addMemory(project.id, `Idea ${i}`, null, "suggested");
  assert.throws(() => store.addMemory(project.id, "One idea too many", null, "suggested"), /waiting/);
  // Waiting suggestions never keep you from writing a note.
  assert.ok(store.addMemory(project.id, "My own note."));
  assert.deepEqual(store.memoryNotes(project.id), ["My own note."]);

  const first = store.listMemory(project.id).find((n) => n.text === "Idea 0")!;
  store.deleteMemory(first.id);
  assert.equal(store.listMemory(project.id).some((n) => n.text === "Idea 0"), false);
  assert.equal(store.addMemory(project.id, "idea 0", null, "suggested"), null);
  // Writing the same note yourself brings it back as an active note.
  assert.equal(store.addMemory(project.id, "Idea 0")?.status, "active");
});

test("project memory holds a limited number of distinct notes", () => {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  assert.ok(store.addMemory(project.id, "Use pnpm."));
  assert.equal(store.addMemory(project.id, "use   PNPM."), null);
  for (let i = 1; i < MAX_MEMORY_NOTES; i++) store.addMemory(project.id, `Note ${i}`);
  assert.equal(store.listMemory(project.id).length, MAX_MEMORY_NOTES);
  assert.throws(() => store.addMemory(project.id, "One too many"), /full/);
  const first = store.listMemory(project.id)[0]!;
  assert.equal(store.updateMemory(first.id, { text: "Use npm." }).text, "Use npm.");
  store.deleteMemory(first.id);
  assert.equal(store.listMemory(project.id).length, MAX_MEMORY_NOTES - 1);
  assert.deepEqual(store.memoryNotes(project.id).slice(0, 2), ["Note 1", "Note 2"]);
});
