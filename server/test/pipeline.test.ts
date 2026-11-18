import { taskMarkdown } from "../src/export.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ProjectInputSchema, type Column, type Task } from "@dot/shared";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Store } from "../src/store.ts";

// These tests run the real orchestrator, store, MCP endpoint and git worktrees. Only the claude CLI
// is replaced, by fake-claude.mjs, which follows a script. See that file for the script format.

const here = dirname(fileURLToPath(import.meta.url));

type Step = { say: string } | { hang: true } | { tool: string; args?: unknown } | { commit: { file: string; content: string; message: string } };
type Launch = { name?: string; turns: Step[][] };

const plan = {
  headline: "Create hello.txt with a greeting.",
  goal: "Add a greeting file.",
  context: "The repo is empty apart from a readme.",
  acceptanceCriteria: ["hello.txt exists and says hello"],
  filesToTouch: [{ path: "hello.txt", change: "create it" }],
  steps: ["Create hello.txt"],
  testPlan: "Read the file.",
  risks: [],
  assumptions: [],
};
const report = { headline: "Added hello.txt.", summary: "Added hello.txt.", deviations: [], verification: [], followUps: [] };
const review = (verdict: "approve" | "changes_requested") => ({
  verdict,
  headline: verdict === "approve" ? "Approved: hello.txt is right." : "Wrong text in hello.txt.",
  summary: verdict === "approve" ? "Looks right." : "One problem.",
  criteria: [{ criterion: plan.acceptanceCriteria[0], status: verdict === "approve" ? "met" : "not_met", evidence: "Read the file." }],
  issues: verdict === "approve" ? [] : [{ severity: "blocking", title: "Wrong text", details: "It should say hello." }],
  checks: [],
});
const commit = { commit: { file: "hello.txt", content: "hello\n", message: "Add hello.txt" } };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function harness(launches: Launch[], extra: Partial<ConstructorParameters<typeof Orchestrator>[2]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dot-pipeline-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  copyFileSync(join(here, "fake-claude.mjs"), join(binDir, "fake-claude.mjs"));
  writeFileSync(join(binDir, "scenario.json"), JSON.stringify({ launches }));
  process.env.DOT_CLAUDE_BIN = join(binDir, "fake-claude.mjs");

  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");

  const store = new Store(openDb(":memory:"));
  const bus = new EventBus();
  const port = await freePort();
  const orchestrator = new Orchestrator(store, bus, {
    port,
    maxAgents: 1,
    model: "fake",
    worktreesDir: join(dir, "worktrees"),
    guardRules: [],
    ...extra,
  });
  const app = createApp(store, bus, orchestrator, {
    attachmentsDir: join(dir, "attachments"),
    reposDir: join(dir, "repos"),
    auth: new Auth(null, null, null),
  });
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  cleanups.push(async () => {
    orchestrator.shutdown();
    server.close();
    // Git may still hold a worktree for a moment on Windows.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  const project = store.createProject(ProjectInputSchema.parse({ name: "Test", repoPath: repo, baseBranch: "main" }));
  const task = store.createTask({ projectId: project.id, title: "Add a greeting", description: "Make hello.txt.", blockedBy: [] });

  const calls = () =>
    readFileSync(join(binDir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  async function until(what: string, check: (task: Task) => boolean, ms = 15_000): Promise<Task> {
    const deadline = Date.now() + ms;
    for (;;) {
      const current = store.getTask(task.id);
      if (check(current)) return current;
      if (Date.now() > deadline) {
        const messages = store.listMessages(task.id).map((m) => `${m.kind}: ${m.text}`);
        assert.fail(`Timed out waiting for ${what}. Task is in ${current.column}, needsInput=${current.needsInput}.\n${messages.join("\n")}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const inColumn = (column: Column) => (t: Task) => t.column === column && t.agentState !== "running" && t.agentState !== "queued";

  return { store, bus, orchestrator, task, repo, calls, until, inColumn };
}

test("a task goes from the inbox to merge approval through three agents", async () => {
  const h = await harness([
    { name: "researcher", turns: [[{ say: "Reading the repo." }, { tool: "submit_plan", args: plan }]] },
    { name: "executor", turns: [[commit, { tool: "submit_execution_report", args: report }]] },
    { name: "reviewer", turns: [[{ tool: "submit_review", args: review("approve") }]] },
  ]);

  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", (t) => t.column === "plan_review");
  assert.equal(h.store.latestPlan(h.task.id)?.plan.goal, plan.goal);

  await h.orchestrator.approvePlan(h.task.id);
  await h.until("review", (t) => t.column === "review");
  const executed = h.store.getTask(h.task.id);
  assert.match(executed.branch ?? "", /^dot\/\d+-add-a-greeting$/);
  assert.equal(h.store.latestExecutionReport(h.task.id)?.report.summary, report.summary);
  assert.deepEqual(
    h.store.latestExecutionReport(h.task.id)?.commits.map((c) => c.subject),
    ["Add hello.txt"],
  );

  await h.until("merge approval", h.inColumn("merge_approval"));
  assert.equal(h.store.latestReview(h.task.id)?.review.verdict, "approve");

  // The executor ran inside the task's worktree, and the researcher in the repo itself.
  const launches = h.calls().filter((c) => "prompt" in c);
  assert.equal(launches.length, 3);
  assert.equal(launches[1]!.cwd, executed.worktreePath);
  assert.notEqual(launches[0]!.cwd, executed.worktreePath);
  assert.match(String(launches[1]!.prompt), /hello\.txt/);

  // The export holds the request and the latest plan, report and review.
  const markdown = taskMarkdown(h.store, h.task.id);
  assert.match(markdown, /^# #1 Add a greeting/);
  assert.match(markdown, /## Request\n\nMake hello\.txt\./);
  assert.match(markdown, /## Plan \(version 1\)/);
  assert.match(markdown, /1\. Create hello\.txt/);
  assert.match(markdown, /`[0-9a-f]+` Add hello\.txt/);
  assert.match(markdown, /## Review \(round 1, approved\)/);
  assert.match(markdown, /## History\n\n- [^\n]*moved to Research[\s\S]*moved to Merge approval/);

  // Cost from each run is recorded.
  const runs = h.orchestrator.runsFor(h.task.id);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.costUsd > 0));
  // The task carries the sum, so the board card can show it.
  const total = runs.reduce((sum, r) => sum + r.costUsd, 0);
  assert.ok(Math.abs(h.store.getTask(h.task.id).costUsd - total) < 1e-9);
});

test("retrying the executor starts a new session on the same branch, and the reviewer runs again", async () => {
  const again = { commit: { file: "hello.txt", content: "hello again\n", message: "Reword hello.txt" } };
  const h = await harness([
    { turns: [[{ tool: "submit_plan", args: plan }]] },
    { turns: [[commit, { tool: "submit_execution_report", args: report }]] },
    { turns: [[{ tool: "submit_review", args: review("approve") }]] },
    { turns: [[again, { tool: "submit_execution_report", args: report }]] },
    { turns: [[{ tool: "submit_review", args: review("approve") }]] },
  ]);

  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", (t) => t.column === "plan_review");
  await h.orchestrator.approvePlan(h.task.id);
  await h.until("merge approval", h.inColumn("merge_approval"));
  const branch = h.store.getTask(h.task.id).branch;

  await h.orchestrator.retryFrom(h.task.id, "execute");
  await h.until("a second review", (t) => (h.store.latestReview(t.id)?.version ?? 0) === 2 && h.inColumn("merge_approval")(t));

  const prompts = h.calls().filter((c) => "prompt" in c);
  const retried = prompts[3]!;
  assert.equal(retried.resume, false);
  assert.match(String(retried.prompt), /session was discarded/);
  assert.equal(h.store.getTask(h.task.id).branch, branch);
  assert.equal(h.orchestrator.runsFor(h.task.id).filter((r) => r.stage === "execute").length, 2);
  assert.equal(h.store.latestReview(h.task.id)?.version, 2);
});

test("a blocked task that asked to start by itself starts research once its blocker is done", async () => {
  const h = await harness([{ turns: [[{ tool: "submit_plan", args: plan }]] }]);
  const waiting = h.store.createTask({
    projectId: h.task.projectId,
    title: "Follow-up",
    description: "",
    blockedBy: [h.task.id],
    autoStart: true,
  });
  const manual = h.store.createTask({ projectId: h.task.projectId, title: "Manual", description: "", blockedBy: [h.task.id] });

  h.orchestrator.startUnblocked();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.store.getTask(waiting.id).column, "inbox", "still blocked");

  h.store.moveTask(h.task.id, { column: "done", beforeTaskId: null });
  h.bus.publish({ type: "tasks.changed", projectId: h.task.projectId, taskId: h.task.id });

  const deadline = Date.now() + 10_000;
  while (h.store.getTask(waiting.id).column === "inbox") {
    assert.ok(Date.now() < deadline, "the follow-up never started");
    await new Promise((r) => setTimeout(r, 50));
  }
  const started = h.store.getTask(waiting.id);
  assert.equal(started.column === "research" || started.column === "plan_review", true);
  assert.equal(started.autoStart, false);
  assert.equal(h.store.getTask(manual.id).column, "inbox", "a task without the flag waits for you");
  while (h.store.getTask(waiting.id).agentState === "running" || h.store.getTask(waiting.id).agentState === "queued") {
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("splitting a plan moves steps into a linked task that starts after this one", async () => {
  const big = { ...plan, steps: ["Create hello.txt", "Add a farewell", "Document both"] };
  const h = await harness([{ turns: [[{ tool: "submit_plan", args: big }]] }]);
  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", (t) => t.column === "plan_review");

  assert.throws(() => h.orchestrator.splitPlan(h.task.id, { title: "All", steps: [0, 1, 2] }), /at least one step/);
  assert.throws(() => h.orchestrator.splitPlan(h.task.id, { title: "Bad", steps: [7] }), /does not exist/);

  const { task: child, plan: saved } = h.orchestrator.splitPlan(h.task.id, { title: "Docs and farewell", steps: [1, 2] });
  assert.deepEqual(saved.plan.steps, ["Create hello.txt"]);
  assert.equal(saved.version, 2);
  assert.match(saved.plan.assumptions.at(-1) ?? "", /2 steps are left to #\d+/);
  assert.deepEqual(child.blockedBy.map((b) => b.id), [h.task.id]);
  assert.equal(child.autoStart, true);
  assert.match(child.description, /1\. Add a farewell\n2\. Document both/);
  assert.equal(child.column, "inbox");
});

test("ask_human flags the task, and the answer resumes the session", async () => {
  const h = await harness([
    { turns: [[{ tool: "ask_human", args: { question: "Which greeting?", choices: ["hello", "hi"] } }]] },
    { turns: [[{ tool: "submit_plan", args: plan }]] },
  ]);

  h.orchestrator.startResearch(h.task.id);
  // Wait for the process to finish its turn and exit, as it does while a question waits for you.
  const waiting = await h.until("a question", (t) => t.needsInput && t.agentState !== "running");
  assert.equal(waiting.column, "research");
  const question = h.store.listMessages(h.task.id).find((m) => m.kind === "question");
  assert.equal(question?.text, "Which greeting?");

  h.orchestrator.sendMessage(h.task.id, { stage: "research", text: "hello", attachmentIds: [] });
  const planned = await h.until("plan review", (t) => t.column === "plan_review");
  assert.equal(planned.needsInput, false);
  // The answer started a second process in the same session, with the answer as its first message.
  const prompts = h.calls().filter((c) => "prompt" in c);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1]!.prompt, "hello");
  assert.equal(prompts[1]!.resume, true);
});

test("a stage that ends without submitting is nudged once, then flagged", async () => {
  const h = await harness([{ turns: [[{ say: "Thinking." }], [{ say: "Still thinking." }]] }]);

  h.orchestrator.startResearch(h.task.id);
  const stuck = await h.until("a flag", (t) => t.needsInput);
  assert.equal(stuck.column, "research");

  const prompts = h.calls().filter((c) => "prompt" in c);
  assert.equal(prompts.length, 2);
  assert.match(String(prompts[1]!.prompt), /without calling submit_plan/);
  assert.ok(h.store.listMessages(h.task.id).some((m) => /stopped without a plan/.test(m.text)));
});

test("a task pauses at the project budget, and resuming grants another budget", async () => {
  // Each fake launch reports $0.01, so a $0.005 budget trips on the first turn that has no result yet.
  const h = await harness([
    { turns: [[{ say: "Reading the code." }]] },
    { turns: [[{ tool: "submit_plan", args: plan }]] },
  ]);
  h.store.updateProject(h.task.projectId, { taskBudgetUsd: 0.005 });

  h.orchestrator.startResearch(h.task.id);
  const paused = await h.until("a budget pause", (t) => t.needsInput && t.agentState !== "running");
  assert.equal(paused.column, "research");
  assert.ok(h.store.listMessages(h.task.id).some((m) => /Paused at the task budget/.test(m.text)));
  // Dot already said why, so the exit adds no plain "Stopped." line.
  assert.equal(h.store.listMessages(h.task.id).some((m) => m.text === "Stopped."), false);
  // The nudge for a missing plan must not have been sent.
  assert.equal(h.calls().filter((c) => "prompt" in c).length, 1);

  // The resumed researcher hands in its plan in the same turn it overspends, so it is not cut off.
  h.orchestrator.resumeResearch(h.task.id);
  const planned = await h.until("plan review", (t) => t.column === "plan_review");
  assert.equal(planned.needsInput, false);
  // Let the process finish, so cleanup does not remove the repo under its ref audit.
  await h.until("the researcher to exit", (t) => t.agentState === "idle");
});

test("each stage runs on the project's model for it, or the server default", async () => {
  const h = await harness([
    { turns: [[{ tool: "submit_plan", args: plan }]] },
    { turns: [[commit, { tool: "submit_execution_report", args: report }]] },
    { turns: [[{ tool: "submit_review", args: review("approve") }]] },
  ]);
  h.store.updateProject(h.task.projectId, { executeModel: "sonnet", reviewModel: "haiku" });

  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", h.inColumn("plan_review"));
  await h.orchestrator.approvePlan(h.task.id);
  await h.until("merge approval", h.inColumn("merge_approval"));

  const models = h.calls().filter((c) => "prompt" in c).map((c) => c.model);
  assert.deepEqual(models, ["fake", "sonnet", "haiku"]);
  await h.until("the reviewer to exit", (t) => t.agentState === "idle");
});

test("an agent that goes silent mid-turn is stopped and flagged", async () => {
  const h = await harness([{ turns: [[{ say: "Starting." }, { hang: true }]] }], { stuckAfterMs: 300, stuckCheckMs: 50 });

  h.orchestrator.startResearch(h.task.id);
  const flagged = await h.until("a stuck flag", (t) => t.needsInput && t.agentState !== "running");
  assert.equal(flagged.column, "research");
  assert.ok(h.store.listMessages(h.task.id).some((m) => /sent nothing for/.test(m.text)));
  assert.equal(h.store.listMessages(h.task.id).some((m) => m.text === "Stopped."), false);
});

test("failed project checks go back to the executor once, and the reviewer sees the passing run", async () => {
  const h = await harness([
    { turns: [[{ tool: "submit_plan", args: plan }]] },
    { turns: [[{ commit: { file: "hello.txt", content: "wrong\n", message: "Add hello.txt" } }, { tool: "submit_execution_report", args: report }]] },
    { turns: [[commit, { tool: "submit_execution_report", args: report }]] },
    { turns: [[{ tool: "submit_review", args: review("approve") }]] },
  ]);
  // Passes only when hello.txt says hello.
  h.store.updateProject(h.task.projectId, {
    testCommand: `node -e "process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hello'?0:1)"`,
  });

  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", h.inColumn("plan_review"));
  await h.orchestrator.approvePlan(h.task.id);
  await h.until("merge approval", h.inColumn("merge_approval"));

  const prompts = h.calls().filter((c) => "prompt" in c).map((c) => String(c.prompt));
  assert.equal(prompts.length, 4);
  assert.match(prompts[2]!, /some failed/);
  assert.match(prompts[2]!, /test: failed/);
  assert.match(prompts[3]!, /they all passed/);
  const notes = h.store.listMessages(h.task.id).map((m) => m.text);
  assert.ok(notes.some((t) => /goes back to the executor before the review/.test(t)));
  await h.until("the reviewer to exit", (t) => t.agentState === "idle");
});

test("a reviewer that requests changes sends the task back to the executor", async () => {
  const h = await harness([
    { turns: [[{ tool: "submit_plan", args: plan }]] },
    { turns: [[commit, { tool: "submit_execution_report", args: report }]] },
    { turns: [[{ tool: "submit_review", args: review("changes_requested") }]] },
    {
      turns: [
        [
          { commit: { file: "hello.txt", content: "hello world\n", message: "Fix the text" } },
          { tool: "submit_execution_report", args: { ...report, fixes: ["Fixed the text"] } },
        ],
      ],
    },
    { turns: [[{ tool: "submit_review", args: review("approve") }]] },
  ]);

  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", (t) => t.column === "plan_review");
  await h.orchestrator.approvePlan(h.task.id);

  await h.until("merge approval", h.inColumn("merge_approval"), 30_000);
  assert.equal(h.store.latestReview(h.task.id)?.version, 2);
  assert.deepEqual(
    h.store.latestExecutionReport(h.task.id)?.commits.map((c) => c.subject),
    ["Fix the text", "Add hello.txt"],
  );
  // The fix round got the reviewer's issue list.
  const fixPrompt = h.calls().filter((c) => "prompt" in c)[3];
  assert.match(String(fixPrompt?.prompt), /Wrong text/);
});

test("accepted rules reach the agents, and a review's lessons wait as suggestions", async () => {
  const h = await harness([
    { name: "researcher", turns: [[{ tool: "submit_plan", args: plan }]] },
    { name: "executor", turns: [[commit, { tool: "submit_execution_report", args: report }]] },
    {
      name: "reviewer",
      turns: [
        [
          {
            tool: "submit_review",
            args: {
              ...review("approve"),
              lessons: ["Use the shared api client, not fetch.", "keep greetings in HELLO.txt."],
            },
          },
        ],
      ],
    },
  ]);
  const projectId = h.task.projectId;
  h.store.addRule(projectId, "Keep greetings in hello.txt.", "active");
  h.store.addRule(projectId, "Never touch the lockfile.", "dismissed");

  h.orchestrator.startResearch(h.task.id);
  await h.until("plan review", (t) => t.column === "plan_review");
  await h.orchestrator.approvePlan(h.task.id);
  await h.until("merge approval", h.inColumn("merge_approval"));

  // The user's rule is in the researcher's and executor's briefs. The dismissed rule is not.
  const prompts = h.calls().filter((c) => "prompt" in c).map((c) => String(c.prompt));
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /# Project rules[\s\S]*- Keep greetings in hello\.txt\./);
    assert.doesNotMatch(prompt, /lockfile/);
  }

  // Of two lessons, one repeats an active rule in different case, so only the other is suggested.
  const rules = h.store.listRules(projectId);
  assert.deepEqual(
    rules.map((r) => [r.text, r.status]),
    [
      ["Keep greetings in hello.txt.", "active"],
      ["Use the shared api client, not fetch.", "suggested"],
    ],
  );
  assert.equal(rules[1]!.sourceTaskId, h.task.id);
  // A suggestion is not an instruction until the user accepts it.
  assert.deepEqual(h.store.activeRules(projectId), ["Keep greetings in hello.txt."]);

  h.store.updateRule(rules[1]!.id, { status: "active" });
  assert.equal(h.store.activeRules(projectId).length, 2);
  h.store.deleteRule(rules[1]!.id);
  assert.equal(h.store.listRules(projectId).length, 1);
  // Removing a rule keeps it dismissed, so the reviewer can't bring it back.
  assert.equal(h.store.addRule(projectId, "use the shared API client,  not fetch.", "suggested"), null);
});
