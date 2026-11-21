import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_MEMORY_NOTES, MAX_PENDING_MEMORY, planSubtaskProblem, type Plan } from "@dot/shared";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { EventBus } from "../src/events.ts";
import { excludeFromGit } from "../src/git.ts";
import { previewNote, previewPageRules } from "../src/agents/executor.ts";
import { capturePreview, findBrowser, previewMode, previewUrl } from "../src/preview.ts";
import { fileResponse, parseRange, serveFolder } from "../src/site.ts";
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

test("a preview link opens the page in a sandbox and refuses anything outside the worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-site-link-"));
  const tree = join(dir, "tree");
  mkdirSync(join(tree, ".dot-preview"), { recursive: true });
  mkdirSync(join(tree, "assets"));
  mkdirSync(join(tree, ".git"));
  writeFileSync(join(tree, ".dot-preview", "index.html"), "<p>page</p>");
  writeFileSync(join(tree, "assets", "main.css"), "body{}");
  writeFileSync(join(tree, ".git", "HEAD"), "ref");
  writeFileSync(join(tree, ".env"), "SECRET=1");
  writeFileSync(join(dir, "outside.txt"), "outside");

  const store = new Store(openDb(":memory:"));
  const project = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  const task = store.createTask({ projectId: project.id, title: "T", description: "" } as never);
  store.setTaskWorkspace(task.id, "task", tree);
  const auth = new Auth("pw", "secret", null);
  const app = createApp(store, new EventBus(), {} as never, { attachmentsDir: "/tmp/a", reposDir: "/tmp/r", auth });
  const headers = { host: "127.0.0.1" };

  // Signed out, the link cannot be made. Without a preview page it cannot be made either.
  assert.equal((await app.request(`/api/tasks/${task.id}/site-link`, { method: "POST", headers })).status, 401);
  const token = auth.siteToken(task.id);
  const page = await app.request(`/api/site/${token}/.dot-preview/index.html`, { headers });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<p>page</p>");
  assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /allow-same-origin/);

  // The sandboxed page's own requests look cross-site and carry Origin: null. They still load.
  const sub = await app.request(`/api/site/${token}/assets/main.css`, { headers: { ...headers, "sec-fetch-site": "cross-site", origin: "null" } });
  assert.equal(sub.status, 200);
  assert.match(sub.headers.get("content-type") ?? "", /text\/css/);

  for (const path of ["/%2e%2e/outside.txt", "/.git/HEAD", "/.env", "/missing.html"]) {
    assert.equal((await app.request(`/api/site/${token}${path}`, { headers })).status, 404, path);
  }
  // Forged, tampered and other-task tokens are refused, and the rest of the API still needs a sign-in.
  assert.equal((await app.request(`/api/site/${token}x/.dot-preview/index.html`, { headers })).status, 404);
  assert.equal((await app.request(`/api/site/${task.id}.1.99999999999999.abc/.dot-preview/index.html`, { headers })).status, 404);
  assert.equal((await app.request(`/api/tasks/${task.id}`, { headers })).status, 401);
  assert.equal(auth.siteTaskId(token), task.id);
  assert.equal(auth.siteTaskId(token.replace(`${task.id}.`, `${task.id + 1}.`)), null);
});

test("a preview server answers under its prefix only", async () => {
  const root = mkdtempSync(join(tmpdir(), "dot-prefix-"));
  mkdirSync(join(root, "theme"));
  writeFileSync(join(root, "theme", "main.css"), "body{}");
  const site = await serveFolder(root, "/site/");
  try {
    assert.equal(site.url.pathname, "/site/");
    assert.equal((await fetch(new URL("theme/main.css", site.url))).status, 200);
    // An absolute link skips the prefix, as it does behind the Open page link.
    assert.equal((await fetch(new URL("/theme/main.css", site.url))).status, 404);
  } finally {
    site.close();
  }
});

test("ranges are read the way browsers send them", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "invalid");
  assert.equal(parseRange("bytes=-0", 100), "invalid");
  assert.equal(parseRange("bytes=0-1,5-9", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test("files stream with ranges, and an empty file is not a range error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-file-"));
  const file = join(dir, "note.txt");
  writeFileSync(file, "0123456789");
  const whole = fileResponse(file, "GET", null);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await whole.text(), "0123456789");
  const part = fileResponse(file, "GET", "bytes=2-4");
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");
  assert.equal(fileResponse(file, "GET", "bytes=50-").status, 416);
  const head = fileResponse(file, "HEAD", null);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  const empty = join(dir, "empty.txt");
  writeFileSync(empty, "");
  assert.equal(fileResponse(empty, "GET", null).status, 200);
});

test("the executor may write the preview page at Merge approval, and nothing else", () => {
  const store = new Store(openDb(":memory:"));
  const base = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  const page = { ...base, previewPath: ".dot-preview/index.html" };
  const approval = { column: "merge_approval" } as const;
  assert.deepEqual(previewPageRules(page, approval, "execute"), ["Write(.dot-preview/index.html)", "Edit(.dot-preview/index.html)"]);
  assert.equal(previewPageRules(page, { column: "execute" }, "execute"), null);
  assert.equal(previewPageRules(page, approval, "review"), null);
  assert.equal(previewPageRules(base, approval, "execute"), null);
  assert.equal(previewPageRules({ ...page, devCommand: "npm run dev" }, approval, "execute"), null);
  assert.equal(previewPageRules({ ...page, previewPath: "../x.html" }, approval, "execute"), null);
});

test("the executor brief asks for a relative, self-contained preview page", () => {
  const store = new Store(openDb(":memory:"));
  const base = store.createProject({ name: "P", repoPath: "/tmp/p", baseBranch: "main", browserTesting: false } as never);
  assert.deepEqual(previewNote(base), []);
  assert.deepEqual(previewNote({ ...base, previewPath: "p.html", devCommand: "npm run dev" }), []);
  const note = previewNote({ ...base, previewPath: "p.html", previewBuild: "npm run build" }).join(" ");
  assert.match(note, /p.html/);
  assert.match(note, /npm run build/);
  assert.match(note, /relative links/);
});

// capturePreview with a stand-in browser path: these cases end before the browser would start.
async function withBrowserPath<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.DOT_BROWSER_BIN;
  process.env.DOT_BROWSER_BIN = process.execPath;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DOT_BROWSER_BIN;
    else process.env.DOT_BROWSER_BIN = saved;
  }
}

function tinyRepo(): { dir: string; run: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "dot-page-"));
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  writeFileSync(join(dir, "built.css"), "committed");
  writeFileSync(join(dir, "work.txt"), "committed");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  return { dir, run };
}

test("a failing build or a missing page ends the preview with a clear error", async () => {
  const { dir } = tinyRepo();
  const store = new Store(openDb(":memory:"));
  const base = store.createProject({ name: "P", repoPath: dir, baseBranch: "main", browserTesting: false } as never);
  const project = { ...base, previewPath: ".dot-preview/index.html" };
  await withBrowserPath(async () => {
    const failed = await capturePreview({ ...project, previewBuild: "exit 3" }, dir);
    assert.equal(failed.ok, false);
    assert.match(failed.ok ? "" : failed.error, /build command failed/);
    const missing = await capturePreview(project, dir);
    assert.match(missing.ok ? "" : missing.error, /This branch has no/);
  });
});

test("the preview build leaves a clean worktree as it found it, and never touches unfinished work", async () => {
  const { dir } = tinyRepo();
  const store = new Store(openDb(":memory:"));
  const base = store.createProject({ name: "P", repoPath: dir, baseBranch: "main", browserTesting: false } as never);
  const project = { ...base, previewPath: ".dot-preview/index.html", previewBuild: "echo rebuilt> built.css" };
  await withBrowserPath(async () => {
    await capturePreview(project, dir);
    assert.equal(readFileSync(join(dir, "built.css"), "utf8"), "committed");

    // Uncommitted work means the build cannot be told apart from it, so nothing is restored.
    writeFileSync(join(dir, "work.txt"), "unfinished");
    await capturePreview(project, dir);
    assert.equal(readFileSync(join(dir, "work.txt"), "utf8"), "unfinished");
    assert.match(readFileSync(join(dir, "built.css"), "utf8"), /rebuilt/);
  });
});
