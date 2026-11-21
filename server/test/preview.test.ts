import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_MEMORY_NOTES, MAX_PENDING_MEMORY, planSubtaskProblem, type Plan } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { excludeFromGit } from "../src/git.ts";
import { findBrowser, previewMode, previewUrl, serveFolder } from "../src/preview.ts";
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

test("a project previews through a dev server or a static page", () => {
  const store = new Store(openDb(":memory:"));
  const project = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  assert.equal(previewMode(project), null);
  assert.equal(previewMode({ ...project, devCommand: "npm run dev", devUrl: "http://localhost:5173" }), "server");
  // A dev command with a non-local address is not a preview.
  assert.equal(previewMode({ ...project, devCommand: "npm run dev", devUrl: "https://example.com" }), null);
  assert.equal(previewMode({ ...project, previewPath: ".dot-preview/index.html" }), "page");
  assert.equal(previewMode({ ...project, previewPath: "../outside.html" }), null);
  assert.equal(previewMode({ ...project, previewPath: "/etc/passwd" }), null);
  const saved = store.updateProject(project.id, { previewPath: "preview.html", previewBuild: "npm run build" });
  assert.equal(saved.previewPath, "preview.html");
  assert.equal(saved.previewBuild, "npm run build");
});

test("the preview server serves the worktree and nothing outside it", async () => {
  const outer = mkdtempSync(join(tmpdir(), "dot-site-"));
  const root = join(outer, "root");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "assets", "main.css"), "body{}");
  writeFileSync(join(outer, "secret.txt"), "secret");
  const site = await serveFolder(root);
  try {
    const get = (path: string) => fetch(new URL(path, site.url));
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.equal(await home.text(), "<h1>home</h1>");
    const css = await get("/assets/main.css");
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.equal((await get("/missing.html")).status, 404);
    assert.equal((await get("/%2e%2e/secret.txt")).status, 404);
    assert.equal((await get("/..%2fsecret.txt")).status, 404);
    assert.equal((await fetch(site.url, { method: "POST" })).status, 404);
  } finally {
    site.close();
  }
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

test("the preview page stays out of git status in a worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-exclude-"));
  const repo = join(dir, "repo");
  const tree = join(dir, "tree");
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  mkdirSync(repo);
  run(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "init");
  run(repo, "worktree", "add", "-q", "-b", "task", tree);
  mkdirSync(join(tree, ".dot-preview"));
  writeFileSync(join(tree, ".dot-preview", "index.html"), "<p>x</p>");
  assert.match(run(tree, "status", "--porcelain"), /\.dot-preview/);
  await excludeFromGit(tree, ".dot-preview/index.html");
  await excludeFromGit(tree, ".dot-preview/index.html");
  assert.equal(run(tree, "status", "--porcelain").trim(), "");
  assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("/.dot-preview/index.html").length, 2);
});
