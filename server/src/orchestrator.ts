import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecutionReportSchema,
  MAX_REVIEW_ROUNDS,
  PlanSchema,
  ReviewSchema,
  STAGE_LABELS,
  type AgentStage,
  type ChatMessage,
  type Column,
  type Plan,
  type Run,
  type Task,
} from "@dot/shared";
import { z } from "zod";
import { ClaudeProcess, claudeTokenFor, describeToolUse, type ContentBlock, type StreamEvent } from "./agents/claude.ts";
import {
  RESEARCHER_ALLOWED_TOOLS,
  RESEARCHER_DENIED_TOOLS,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
  researcherBrief,
} from "./agents/researcher.ts";
import {
  EXECUTOR_ALLOWED_TOOLS,
  EXECUTOR_DENIED_TOOLS,
  EXECUTOR_SYSTEM_PROMPT,
  EXECUTOR_TOOLS,
  executorBrief,
} from "./agents/executor.ts";
import {
  REVIEWER_DENIED_TOOLS,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_TOOLS,
  fixRequest,
  reviewerAllowedTools,
  reviewerBrief,
  reviewerFollowUp,
} from "./agents/reviewer.ts";
import { HttpError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { BuildStatus } from "./bitbucket.ts";
import { repoHostFor, trustedOrigin, type RepoHostClient } from "./githost.ts";
import {
  branchSlug,
  commitsAhead,
  deleteBranch,
  fetchBase,
  mergeConflicts,
  resolveBaseRef,
  pushBranch,
  remoteUrl,
  gitError,
  prepareWorktree,
  refChanges,
  removeWorktree,
  snapshotRefs,
  uncommittedChanges,
  type RefSnapshot,
  type Workspace,
} from "./git.ts";
import { defineTool, handleMcp, type McpTool } from "./mcp.ts";
import type { Attachment, Store } from "./store.ts";

export type OrchestratorConfig = {
  port: number;
  maxAgents: number;
  model: string;
  worktreesDir: string;
  // Deny rules every agent gets, see agents/guards.ts.
  guardRules: string[];
};

// The column a stage's agent works in. Outside it, the agent is only chatting.
const STAGE_COLUMN: Record<AgentStage, Column> = {
  research: "research",
  execute: "execute",
  review: "review",
};

type StageConfig = {
  tools: string[];
  allowedTools: string[];
  deniedTools: string[];
  systemPrompt: string;
  // Sent once when a working turn ends without the stage's submit tool or a question.
  nudge: string;
  stalled: string;
};

const STAGE_CONFIG: Record<AgentStage, StageConfig> = {
  research: {
    tools: RESEARCHER_TOOLS,
    allowedTools: RESEARCHER_ALLOWED_TOOLS,
    deniedTools: RESEARCHER_DENIED_TOOLS,
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    nudge:
      "You ended your turn without calling submit_plan or ask_human. Continue the research. " +
      "When you are ready, call submit_plan. If you need a decision from the user, call ask_human.",
    stalled: "The researcher stopped without a plan or a question. Reply here to tell it how to continue.",
  },
  execute: {
    tools: EXECUTOR_TOOLS,
    allowedTools: EXECUTOR_ALLOWED_TOOLS,
    deniedTools: EXECUTOR_DENIED_TOOLS,
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    nudge:
      "You ended your turn without calling submit_execution_report or ask_human. Continue implementing the plan. " +
      "When the work is committed, call submit_execution_report. If you need a decision from the user, call ask_human.",
    stalled: "The executor stopped without a report or a question. Reply here to tell it how to continue.",
  },
  review: {
    tools: REVIEWER_TOOLS,
    // Filled per project at launch: the project's own test, lint and typecheck commands are added.
    allowedTools: [],
    deniedTools: REVIEWER_DENIED_TOOLS,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    nudge:
      "You ended your turn without calling submit_review or ask_human. Continue the review. " +
      "When you have checked every acceptance criterion, call submit_review.",
    stalled: "The reviewer stopped without a review or a question. Reply here to tell it how to continue.",
  },
};

// In-memory state for a run while Dot is up. The database holds everything that must survive a restart.
type Live = {
  runId: number;
  taskId: number;
  token: string | null;
  process: ClaudeProcess | null;
  // This turn should end with submit_plan or ask_human. False while the user is only chatting.
  expectOutcome: boolean;
  outcome: boolean;
  nudged: boolean;
  costBase: number;
  // Messages that arrived while no process could take them. The next launch sends them.
  pending: ContentBlock[][];
  stopped: boolean;
  // Resolves when the current process exits. Already resolved while none is running.
  exited: Promise<void>;
  resolveExited: () => void;
  // The repo's refs when the working executor last started or was audited. Null for other agents.
  refs: Promise<RefSnapshot | null> | null;
  // Set when the executor's report is accepted. The reviewer starts once this process exits,
  // so the two never work in the worktree at the same time.
  reviewOnExit: boolean;
  // Set when the reviewer requests changes. The executor's fix round starts once this process exits.
  fixOnExit: { executorRunId: number; prompt: string } | null;
  stage: AgentStage;
};

export class Orchestrator {
  private readonly live = new Map<number, Live>();
  private readonly tokens = new Map<string, number>();
  private readonly queue: number[] = [];

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly config: OrchestratorConfig,
  ) {}

  // Public actions

  startResearch(taskId: number): Task {
    const task = this.store.getTask(taskId);
    // A card dragged into Research by hand has no run yet, so it can start from there too.
    const inResearchUnstarted = task.column === "research" && !this.store.latestRun(taskId, "research");
    if (task.column !== "inbox" && !inResearchUnstarted) {
      throw new HttpError(409, "Only tasks in the Inbox can start research");
    }
    if (task.blockedBy.length > 0) {
      throw new HttpError(409, `Blocked by ${task.blockedBy.map((b) => `#${b.number}`).join(", ")}. Finish those first.`);
    }
    const project = this.store.getProject(task.projectId);

    if (task.column === "inbox") this.store.moveTask(taskId, { column: "research", beforeTaskId: null });
    this.store.setNeedsInput(taskId, false);
    const run = this.store.createRun(taskId, "research", randomUUID());
    this.store.addMessage({ taskId, runId: run.id, role: "system", kind: "status", text: "Research started." });
    this.dispatch(run.id, buildContent(researcherBrief(task, project), this.store.taskAttachments(taskId)), true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // Picks the researcher up again after a Stop or a stall, in its existing session.
  resumeResearch(taskId: number): Task {
    const task = this.store.getTask(taskId);
    if (task.column !== "research") throw new HttpError(409, "Only a task in Research can resume the researcher");
    const run = this.store.latestRun(taskId, "research");
    if (!run) throw new HttpError(409, "This task has no researcher yet");
    if (run.status === "running" || run.status === "queued") throw new HttpError(409, "The researcher is already running");

    this.store.setNeedsInput(taskId, false);
    this.store.addMessage({ taskId, runId: run.id, role: "system", kind: "status", text: "Researcher resumed." });
    const content: ContentBlock[] = run.sessionStarted
      ? [{ type: "text", text: "Continue the research. When you are ready, call submit_plan. If you need a decision from the user, call ask_human." }]
      : buildContent(researcherBrief(task, this.store.getProject(task.projectId)), this.store.taskAttachments(taskId));
    this.dispatch(run.id, content, true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  sendMessage(taskId: number, input: { stage: AgentStage; text: string; attachmentIds: number[] }): ChatMessage {
    const task = this.store.getTask(taskId);
    const run = this.store.latestRun(taskId, input.stage);
    if (!run) throw new HttpError(409, "This agent has not started yet. Start the task first.");
    // The executor and reviewer live in the task's worktree, which the merge removes.
    // Check before storing the message, so a message that can never be answered isn't saved.
    if (input.stage !== "research" && (!task.worktreePath || !existsSync(task.worktreePath))) {
      throw new HttpError(
        409,
        `The ${STAGE_LABELS[input.stage].toLowerCase()} can't run anymore: its worktree was removed when the task was merged. The researcher is still available.`,
      );
    }

    const attachments = input.attachmentIds.map((id) => this.store.getAttachment(id));
    if (attachments.some((a) => a.taskId !== taskId)) throw new HttpError(400, "Attachment belongs to another task");

    const message = this.store.addMessage({
      taskId,
      runId: run.id,
      role: "user",
      kind: "text",
      text: input.text,
      data: attachments.length > 0 ? { attachments: attachments.map(({ id, fileName, mediaType }) => ({ id, fileName, mediaType })) } : null,
    });
    this.store.markQuestionsAnswered(run.id);
    if (task.needsInput) this.store.setNeedsInput(taskId, false);

    const expectOutcome = task.column === STAGE_COLUMN[input.stage];
    this.dispatch(run.id, buildContent(input.text, attachments), expectOutcome);
    this.publish(taskId);
    return message;
  }

  async approvePlan(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "plan_review") throw new HttpError(409, "Only a task in Plan review can be approved");
    const plan = this.store.latestPlan(taskId);
    if (!plan) throw new HttpError(409, "This task has no plan yet");

    this.store.moveTask(taskId, { column: "execute", beforeTaskId: null });
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: `Plan v${plan.version} approved.` });
    return this.startExecution(taskId);
  }

  // Tasks whose worktree is being prepared, so a double click can't start two executors.
  private readonly starting = new Set<number>();

  // Creates or reuses the task's worktree and starts (or resumes) the executor in it.
  // Also the retry and resume path after a failure or a Stop.
  async startExecution(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "execute") throw new HttpError(409, "Only a task in Execute can start the executor");
    const plan = this.store.latestPlan(taskId);
    if (!plan) throw new HttpError(409, "This task has no approved plan");
    const existing = this.store.latestRun(taskId, "execute");
    if (this.starting.has(taskId) || (existing && (existing.status === "running" || existing.status === "queued"))) {
      throw new HttpError(409, "The executor is already running");
    }
    const project = this.store.getProject(task.projectId);

    let workspace: Workspace;
    this.starting.add(taskId);
    try {
      // Start from origin's base, not a local branch that may be behind.
      const fetched = await fetchBase(project.repoPath, project.baseBranch, trustedOrigin(project));
      workspace = await prepareWorktree({
        repo: project.repoPath,
        base: project.baseBranch,
        baseRef: fetched.ref,
        branch: task.branch ?? branchSlug(task.id, task.title),
        knownBranch: task.branch !== null,
        path: task.worktreePath ?? join(this.config.worktreesDir, String(task.id)),
        worktreesDir: this.config.worktreesDir,
      });
      if (fetched.note) workspace.notes.unshift(fetched.note);
    } catch (err) {
      this.store.setNeedsInput(taskId, true);
      this.store.setAgentState(taskId, "failed");
      this.store.addMessage({
        taskId,
        runId: existing?.id ?? null,
        role: "system",
        kind: "error",
        text: `Could not create the worktree.\n\n${gitError(err)}`,
      });
      this.publish(taskId);
      return this.store.getTask(taskId);
    } finally {
      this.starting.delete(taskId);
    }
    const { branch, path, notes } = workspace;
    this.store.setTaskWorkspace(taskId, branch, path);
    this.store.setNeedsInput(taskId, false);

    const run = existing ?? this.store.createRun(taskId, "execute", randomUUID());
    for (const note of notes) this.store.addMessage({ taskId, runId: run.id, role: "system", kind: "status", text: note });
    this.store.addMessage({
      taskId,
      runId: run.id,
      role: "system",
      kind: "status",
      text: existing ? `Executor resumed on ${branch}.` : `Execution started on ${branch}.`,
    });

    const prompt = run.sessionStarted
      ? "Continue implementing the approved plan. When the work is committed, call submit_execution_report."
      : executorBrief(this.store.getTask(taskId), project, plan.plan, plan.version, branch);
    this.dispatch(run.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // True when the latest execution report has no review yet.
  private reviewPending(taskId: number): boolean {
    const report = this.store.latestExecutionReport(taskId);
    return report !== null && this.store.latestReview(taskId)?.reportVersion !== report.version;
  }

  // Starts the reviewer for the latest execution report, or picks it up again after a Stop.
  // Two counts: the round number shown everywhere is the review's version, so it keeps counting
  // across your change requests. task.reviewRound counts reviews since the last one of yours and
  // only drives the MAX_REVIEW_ROUNDS stop. Both change only when a review is submitted, so
  // starting or resuming never skips a number.
  async startReview(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "review") throw new HttpError(409, "Only a task in Review can start the reviewer");
    const plan = this.store.latestPlan(taskId);
    const report = this.store.latestExecutionReport(taskId);
    if (!plan || !report) throw new HttpError(409, "This task has no execution report to review");
    const existing = this.store.latestRun(taskId, "review");
    if (this.starting.has(taskId) || (existing && (existing.status === "running" || existing.status === "queued"))) {
      throw new HttpError(409, "The reviewer is already running");
    }
    if (!this.reviewPending(taskId)) {
      throw new HttpError(409, "The latest report is already reviewed. Approve it, or request changes.");
    }
    const round = (this.store.latestReview(taskId)?.version ?? 0) + 1;
    const project = this.store.getProject(task.projectId);

    // The reviewer diffs against the same base the executor's branch started from.
    this.starting.add(taskId);
    let baseRef: string;
    try {
      baseRef = await resolveBaseRef(project.repoPath, project.baseBranch);
    } finally {
      this.starting.delete(taskId);
    }

    this.store.setNeedsInput(taskId, false);
    const run = existing ?? this.store.createRun(taskId, "review", randomUUID());
    this.store.addMessage({ taskId, runId: run.id, role: "system", kind: "status", text: `Review round ${round} started.` });
    const prompt = run.sessionStarted
      ? reviewerFollowUp(report, round, baseRef)
      : reviewerBrief(this.store.getTask(taskId), project, plan.plan, plan.version, report, round, baseRef);
    this.dispatch(run.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // Your override in Review: accept the change without (another) agent review.
  async approveReview(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "review") throw new HttpError(409, "Only a task in Review can be approved");
    await this.stop(taskId);
    this.store.moveTask(taskId, { column: "merge_approval", beforeTaskId: null });
    this.store.setNeedsInput(taskId, false);
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: "You approved the change." });
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // Your override in Review or Merge approval: send the executor your own list of changes.
  async requestChanges(taskId: number, notes: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "review" && task.column !== "merge_approval" && task.column !== "merge") {
      throw new HttpError(409, "Changes can only be requested in Review, Merge approval or Merge");
    }
    if (this.merging.has(taskId)) throw new HttpError(409, "Stop the merge before requesting changes");
    const run = this.store.latestRun(taskId, "execute");
    if (!run) throw new HttpError(409, "This task has no executor");
    await this.stop(taskId);

    this.store.moveTask(taskId, { column: "execute", beforeTaskId: null });
    this.store.setNeedsInput(taskId, false);
    // Your request starts a new cycle, so the reviewer gets its full number of rounds again.
    this.store.setReviewRound(taskId, 0);
    this.store.addMessage({ taskId, runId: run.id, role: "user", kind: "text", text: `Requested changes:\n\n${notes}` });
    this.dispatch(run.id, [{ type: "text", text: fixRequest([], 0, MAX_REVIEW_ROUNDS, notes) }], true); // round unused with notes
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // Merge step. Plain code, no agent: conflict check, push, pull request, wait for CI,
  // squash merge, clean up. Every step can safely run again, so Retry and restart recovery
  // just run the whole job from the top.

  private readonly merging = new Map<number, AbortController>();

  async startMerge(taskId: number, options: { skipCi: boolean }): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "merge_approval" && task.column !== "merge") {
      throw new HttpError(409, "Only a task in Merge approval can be merged");
    }
    if (this.merging.has(taskId)) throw new HttpError(409, "The merge is already running");
    // Fails early with what to set when the host, repo or token is missing.
    await repoHostFor(this.store.getProject(task.projectId));
    if (!task.branch) throw new HttpError(409, "This task has no branch to merge");

    // A chat with a past-stage agent may still be running in the worktree the merge removes at the end.
    this.merging.set(taskId, new AbortController());
    try {
      await this.stop(taskId);
    } finally {
      this.merging.delete(taskId);
    }

    if (task.column === "merge_approval") {
      this.store.moveTask(taskId, { column: "merge", beforeTaskId: null });
      this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: "You approved the merge." });
    }
    this.store.setNeedsInput(taskId, false);
    this.store.setAgentState(taskId, "running");
    this.publish(taskId);
    void this.runMerge(taskId, options.skipCi);
    return this.store.getTask(taskId);
  }

  private async runMerge(taskId: number, skipCi: boolean): Promise<void> {
    const abort = new AbortController();
    this.merging.set(taskId, abort);
    const say = (text: string, kind: "status" | "error" = "status") => {
      this.store.addMessage({ taskId, runId: null, role: "system", kind, text });
      this.publish(taskId);
    };
    const stillMerging = () => {
      if (abort.signal.aborted) throw new Error("aborted");
    };

    try {
      const task = this.store.getTask(taskId);
      const project = this.store.getProject(task.projectId);
      const remote = await repoHostFor(project);
      const branch = task.branch!;
      const repo = project.repoPath;
      const base = project.baseBranch;

      // 0. Already merged? Happens when Dot restarted after the host merged but before cleanup.
      //    Pushing or opening a pull request again would recreate the closed branch.
      const knownPr = task.prId ? await remote.getPullRequest(task.prId) : null;
      if (knownPr?.state === "MERGED") {
        say(`Pull request #${knownPr.id} is already merged. Finishing up.`);
        await this.finishMerge(taskId, knownPr.id);
        return;
      }

      // 1. Would the branch still merge cleanly into origin's current base?
      const fetched = await fetchBase(repo, base, trustedOrigin(project));
      if (fetched.note) say(fetched.note);
      const conflicts = await mergeConflicts(repo, fetched.ref, branch);
      stillMerging();
      if (conflicts.length > 0) {
        const files = conflicts.map((f) => `- ${f}`).join("\n");
        this.sendToExecutor(
          taskId,
          `The base branch ${base} has moved on and now conflicts with your branch in these files:\n\n${files}\n\n` +
            `Merge it into your branch (git merge ${fetched.ref}), resolve the conflicts, rerun the project's checks, ` +
            "commit, and call submit_execution_report. The work goes through review again before it can merge.",
          `${base} now conflicts with ${branch} in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}, so the task went back to the executor to merge ${base} in.`,
        );
        return;
      }

      // 2. Push with your git credentials.
      const origin = await remoteUrl(repo);
      if (!origin) throw new Error(`The repository has no "origin" remote to push to.`);
      const fullName = `${remote.owner}/${remote.name}`;
      const originNote = `Note: origin is ${origin}, which doesn't look like ${remote.label} repo ${fullName} from the project settings.`;
      if (!origin.toLowerCase().includes(fullName.toLowerCase()) && !this.store.listMessages(taskId).some((m) => m.text === originNote)) {
        say(originNote);
      }
      say(`Pushing ${branch} to origin.`);
      // The commit that was pushed, so the build wait and the merge refer to exactly that commit.
      const head = await pushBranch(repo, branch, { origin: trustedOrigin(project), base });
      stillMerging();

      // 3. Reuse the task's pull request while it is open, otherwise find or open one.
      let pr = knownPr?.state === "OPEN" ? knownPr : null;
      pr ??= await remote.findOpenPullRequest(branch);
      if (!pr) {
        pr = await remote.createPullRequest({
          title: task.title,
          description: this.pullRequestDescription(taskId),
          source: branch,
          destination: base,
        });
        say(`Opened pull request #${pr.id}: ${pr.url}`);
      }
      this.store.setPullRequest(taskId, pr.id, pr.url || null);
      this.publish(taskId);
      stillMerging();

      // 4. Wait for CI.
      if (!skipCi) {
        // A repository without CI never reports a build, so waiting the full no-CI time only
        // delays the merge. When the host's own CI isn't set up (no Pipelines or Actions config
        // on the branch, and none in the repository), Dot waits briefly in case another CI
        // service reports, then merges.
        const noPipelines = await remote.hasNoCi(repo, head);
        stillMerging();
        say(
          noPipelines
            ? `This repository has no ${remote.ciName}. Checking briefly whether any other CI reports a build for ${head.slice(0, 12)}.`
            : `Waiting for the build of ${head.slice(0, 12)}.`,
        );
        const outcome = await this.waitForBuilds(remote, head, abort.signal, noPipelines);
        if (outcome.kind === "none" && noPipelines) {
          say("No CI reported a build, so there is nothing to wait for.");
        } else if (outcome.kind === "none") {
          this.store.setNeedsInput(taskId, true);
          this.store.setAgentState(taskId, "waiting");
          say(
            "No build status showed up for this commit. If the repository has no CI, use Merge without CI. " +
              `Otherwise check ${remote.label} and press Retry merge.`,
          );
          return;
        } else if (outcome.kind === "failed") {
          const log = await remote.failedBuildLog(head);
          const failures = outcome.statuses.map((s) => `- ${s.name || s.key}: ${s.state} ${s.url}`).join("\n");
          this.sendToExecutor(
            taskId,
            `The ${remote.label} build failed for your branch:\n\n${failures}` +
              (log ? `\n\nWhat the failed build reported:\n\n${log}` : "") +
              "\n\nFix the cause, commit, and call submit_execution_report. The work goes through review again before it can merge.",
            `The build failed, so the task went back to the executor.\n\n${failures}`,
          );
          return;
        } else {
          say("The build passed.");
        }
      }
      stillMerging();

      // 5. Squash merge.
      say(`Merging pull request #${pr.id} (squash).`);
      await remote.squashMerge(pr.id, this.squashMessage(taskId), branch);

      // 6. Done.
      await this.finishMerge(taskId, pr.id);
    } catch (err) {
      if (abort.signal.aborted) {
        say("Merge stopped.");
        this.store.setAgentState(taskId, "idle");
        return;
      }
      this.store.setNeedsInput(taskId, true);
      this.store.setAgentState(taskId, "failed");
      say(`The merge stopped: ${err instanceof Error ? err.message : gitError(err)}`, "error");
    } finally {
      this.merging.delete(taskId);
      this.publish(taskId);
    }
  }

  // The pull request is merged: move the task to Done and remove the worktree, the local branch
  // and its remote-tracking ref. The merge removed the branch on the host.
  private async finishMerge(taskId: number, prId: number): Promise<void> {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    this.store.moveTask(taskId, { column: "done", beforeTaskId: null });
    this.store.setAgentState(taskId, "idle");
    this.store.addMessage({
      taskId,
      runId: null,
      role: "system",
      kind: "status",
      text: `Merged pull request #${prId} into ${project.baseBranch}.`,
    });
    this.publish(taskId);
    if (task.worktreePath) await removeWorktree(project.repoPath, task.worktreePath);
    if (task.branch) {
      await deleteBranch(project.repoPath, task.branch);
      this.store.setTaskWorkspace(taskId, task.branch, null);
    }
  }

  // Polls the commit's build statuses. "none" when no status shows up at all for a while,
  // which usually means the repository has no CI.
  private async waitForBuilds(
    remote: RepoHostClient,
    commit: string,
    signal: AbortSignal,
    noPipelines: boolean,
  ): Promise<{ kind: "passed" } | { kind: "none" } | { kind: "failed"; statuses: BuildStatus[] }> {
    const pollMs = Number(process.env.DOT_MERGE_POLL_MS ?? 15_000);
    const configuredNoneAfterMs = Number(process.env.DOT_MERGE_NO_CI_MS ?? 5 * 60_000);
    const noneAfterMs = noPipelines ? Math.min(configuredNoneAfterMs, 30_000) : configuredNoneAfterMs;
    const giveUpMs = 60 * 60_000;
    const started = Date.now();
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const statuses = await remote.buildStatuses(commit);
      const elapsed = Date.now() - started;
      // Only these states are final. Anything else, including a state Dot doesn't know, means
      // keep waiting: merging must never happen on a guess.
      const finished = (s: BuildStatus) => s.state === "SUCCESSFUL" || s.state === "FAILED" || s.state === "STOPPED";
      if (statuses.length === 0) {
        if (elapsed > noneAfterMs) return { kind: "none" };
      } else if (statuses.every(finished)) {
        const failed = statuses.filter((s) => s.state !== "SUCCESSFUL");
        return failed.length > 0 ? { kind: "failed", statuses: failed } : { kind: "passed" };
      }
      if (elapsed > giveUpMs) throw new Error("The build didn't finish within an hour.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // Sends merge-time problems (conflicts, a red build) back to the executor as a new fix cycle.
  private sendToExecutor(taskId: number, prompt: string, note: string): void {
    const run = this.store.latestRun(taskId, "execute");
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "error", text: note });
    if (!run) {
      this.store.setNeedsInput(taskId, true);
      this.store.setAgentState(taskId, "failed");
      this.publish(taskId);
      return;
    }
    this.store.moveTask(taskId, { column: "execute", beforeTaskId: null });
    this.store.setReviewRound(taskId, 0);
    this.store.setAgentState(taskId, "idle");
    this.dispatch(run.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
  }

  private pullRequestDescription(taskId: number): string {
    const task = this.store.getTask(taskId);
    const plan = this.store.latestPlan(taskId)?.plan;
    const reports = this.store.listExecutionReports(taskId);
    const review = this.store.latestReview(taskId);
    const section = (title: string, body: string | undefined) => (body?.trim() ? `## ${title}\n\n${body.trim()}` : "");
    // The first report describes the change. Later ones are fix rounds, listed after it.
    const [first, ...later] = reports;
    const changed = first
      ? [first.report.summary, ...later.map((r) => `Fix round: ${r.report.summary}`)].join("\n\n")
      : undefined;
    return [
      task.description.trim(),
      section("Goal", plan?.goal),
      section("Acceptance criteria", plan?.acceptanceCriteria.map((c) => `- ${c}`).join("\n")),
      section("What changed", changed),
      section("Review", review ? `${review.review.summary}\n\nApproved in review round ${review.version}.` : undefined),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private squashMessage(taskId: number): string {
    const task = this.store.getTask(taskId);
    const goal = this.store.latestPlan(taskId)?.plan.goal;
    return goal ? `${task.title}\n\n${goal}` : task.title;
  }

  // Removes a task's worktree folder before the task is deleted. The branch stays in the repo.
  // Call after stop() has resolved: on Windows a running process keeps its folder locked.
  async cleanupWorkspace(taskId: number): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task.worktreePath) return;
    const project = this.store.getProject(task.projectId);
    await removeWorktree(project.repoPath, task.worktreePath);
  }

  sendBack(taskId: number, notes: string): Task {
    const task = this.store.getTask(taskId);
    if (task.column !== "plan_review") throw new HttpError(409, "Only a task in Plan review can be sent back");
    const run = this.store.latestRun(taskId, "research");
    if (!run) throw new HttpError(409, "This task has no research agent");

    this.store.moveTask(taskId, { column: "research", beforeTaskId: null });
    this.store.addMessage({ taskId, runId: run.id, role: "user", kind: "text", text: `Sent the plan back:\n\n${notes}` });
    const prompt = `The user sent the plan back for changes:\n\n${notes}\n\nRevise the plan and submit it again with submit_plan.`;
    this.dispatch(run.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  savePlan(taskId: number, plan: Plan) {
    const task = this.store.getTask(taskId);
    if (task.column !== "research" && task.column !== "plan_review") {
      throw new HttpError(409, "The plan can only change before it is approved");
    }
    const saved = this.store.addPlan(taskId, null, "user", plan);
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: `You edited the plan (v${saved.version}).` });
    this.publish(taskId);
    return saved;
  }

  // Stops the task's agents. Resolves once their processes have exited, or after 5 seconds.
  async stop(taskId: number): Promise<void> {
    // A running merge stops at its next step. Host API calls already sent still finish.
    this.merging.get(taskId)?.abort();
    const exits: Promise<void>[] = [];
    for (const live of this.live.values()) {
      if (live.taskId !== taskId) continue;
      live.stopped = true;
      live.pending = [];
      const queued = this.queue.indexOf(live.runId);
      if (queued !== -1) {
        this.queue.splice(queued, 1);
        this.store.updateRun(live.runId, { status: "idle" });
      }
      if (live.process) {
        exits.push(live.exited);
        live.process.kill();
      }
    }
    if (this.store.getTask(taskId).agentState === "queued") this.store.setAgentState(taskId, "idle");
    this.publish(taskId);
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 5000))]);
  }

  // Kill every agent process. Called on server shutdown so no claude process outlives Dot.
  shutdown(): void {
    for (const live of this.live.values()) {
      live.stopped = true;
      live.process?.kill();
    }
  }

  // After a restart no agent process is running.
  // - An agent that was working in its own column stays paused until you resume it.
  // - A handoff that was waiting for a process to exit (report accepted, so the reviewer should start;
  //   changes requested, so the executor should fix) never happened. Those start now, since the
  //   pipeline had already decided on them.
  recover(): void {
    const interrupted = this.store.listRunsByStatus(["running", "queued"]);
    const pausedTasks = new Set<number>();
    for (const run of interrupted) {
      this.store.updateRun(run.id, { status: "idle" });
      const task = this.store.getTask(run.taskId);
      // An executor that was only finishing its turn after its report doesn't need you.
      if (task.column !== STAGE_COLUMN[run.stage]) {
        this.store.setAgentState(run.taskId, task.needsInput ? "waiting" : "idle");
        continue;
      }
      pausedTasks.add(run.taskId);
      this.store.setNeedsInput(run.taskId, true);
      this.store.setAgentState(run.taskId, "waiting");
      this.store.addMessage({
        taskId: run.taskId,
        runId: run.id,
        role: "system",
        kind: "status",
        text: "Dot restarted while this agent was working. Send a message or press Resume to let it continue.",
      });
    }

    // A merge that was running picks up again from the top. Every merge step is safe to repeat.
    for (const task of this.store.listTasksInColumns(["merge"])) {
      if (task.agentState !== "running") continue;
      this.store.addMessage({
        taskId: task.id,
        runId: null,
        role: "system",
        kind: "status",
        text: "Dot restarted during the merge. Continuing.",
      });
      void this.runMerge(task.id, false);
    }

    for (const task of this.store.listTasksInColumns(["review", "execute"])) {
      if (pausedTasks.has(task.id)) continue;
      try {
        if (task.column === "review" && this.reviewPending(task.id)) {
          this.startReview(task.id).catch((err: unknown) => console.error(`Recovery for task ${task.id} failed:`, err));
          continue;
        }
        // A fix round is pending when the newest review asked for changes on the newest report.
        const report = this.store.latestExecutionReport(task.id);
        const review = this.store.latestReview(task.id);
        const executorRun = this.store.latestRun(task.id, "execute");
        if (
          task.column === "execute" &&
          report &&
          review?.review.verdict === "changes_requested" &&
          review.reportVersion === report.version &&
          executorRun
        ) {
          const prompt = fixRequest(review.review.issues, review.version, MAX_REVIEW_ROUNDS - review.round);
          this.dispatch(executorRun.id, [{ type: "text", text: prompt }], true);
        }
      } catch (err) {
        console.error(`Recovery for task ${task.id} failed:`, err);
      }
    }
  }

  async mcp(token: string, body: unknown): Promise<unknown | null> {
    const runId = this.tokens.get(token);
    if (runId === undefined) throw new HttpError(404, "Unknown agent token");
    return handleMcp(body, this.toolsFor(runId));
  }

  // Tools the agent calls back into Dot with

  private toolsFor(runId: number): McpTool[] {
    const live = this.getLive(runId);
    const run = this.store.getRun(runId);

    const askHuman = defineTool({
      name: "ask_human",
      description:
        "Ask the user a question when a decision is theirs to make. Then end your turn: the answer arrives as the next user message.",
      schema: z.object({
        question: z.string().trim().min(1).describe("One focused question."),
        choices: z.array(z.string().trim().min(1)).max(6).optional().describe("Suggested answers, if any."),
      }),
      handler: ({ question, choices }) => {
        this.store.addMessage({
          taskId: run.taskId,
          runId,
          role: "agent",
          kind: "question",
          text: question,
          data: choices && choices.length > 0 ? { choices } : null,
        });
        this.store.setNeedsInput(run.taskId, true);
        live.outcome = true;
        this.publish(run.taskId);
        return { text: "Your question was sent to the user. End your turn now. Their answer arrives as the next user message." };
      },
    });

    const submitPlan = defineTool({
      name: "submit_plan",
      description:
        "Submit the implementation plan for the user to review. Each call saves a new version. Only works before the plan is approved.",
      schema: PlanSchema,
      handler: (plan) => {
        const task = this.store.getTask(run.taskId);
        if (task.column !== "research" && task.column !== "plan_review") {
          return { text: "The plan is already approved and can no longer change.", isError: true };
        }
        const saved = this.store.addPlan(run.taskId, runId, "agent", plan);
        this.store.addMessage({
          taskId: run.taskId,
          runId,
          role: "agent",
          kind: "plan",
          text: `Submitted plan v${saved.version}.`,
          data: { planVersion: saved.version },
        });
        if (task.column === "research") this.store.moveTask(task.id, { column: "plan_review", beforeTaskId: null });
        live.outcome = true;
        this.publish(run.taskId);
        return {
          text: `Plan saved as version ${saved.version} and sent to the user for review. End your turn now with a short summary of the plan.`,
        };
      },
    });

    const submitExecutionReport = defineTool({
      name: "submit_execution_report",
      description:
        "Report that the plan is implemented and committed. Rejected while the worktree has uncommitted changes or the branch has no commits.",
      schema: ExecutionReportSchema,
      handler: async (report) => {
        const task = this.store.getTask(run.taskId);
        if (task.column !== "execute") {
          return { text: "This task is no longer in the Execute column, so no report is needed.", isError: true };
        }
        if (!task.worktreePath) return { text: "This task has no worktree.", isError: true };
        const project = this.store.getProject(task.projectId);

        // Check git, not the agent's word: the work must be committed on the branch.
        const dirty = await uncommittedChanges(task.worktreePath);
        if (dirty) {
          // Cap the listing: an unignored node_modules alone would flood the agent's context.
          const lines = dirty.split("\n");
          const shown = lines.slice(0, 30).join("\n");
          const more = lines.length > 30 ? `\n...and ${lines.length - 30} more. Check .gitignore.` : "";
          return {
            text: `The worktree has uncommitted changes. Commit them (or remove them if they are not part of the work), then call submit_execution_report again.\n\n${shown}${more}`,
            isError: true,
          };
        }
        const commits = await commitsAhead(task.worktreePath, await resolveBaseRef(project.repoPath, project.baseBranch));
        if (commits.length === 0) {
          return { text: `The branch has no commits ahead of ${project.baseBranch}. Commit your work first.`, isError: true };
        }

        const saved = this.store.addExecutionReport(run.taskId, runId, report, commits);
        this.store.addMessage({
          taskId: run.taskId,
          runId,
          role: "agent",
          kind: "report",
          text: `Submitted the execution report (${commits.length} commit${commits.length === 1 ? "" : "s"}).`,
          data: { reportVersion: saved.version },
        });
        this.store.moveTask(task.id, { column: "review", beforeTaskId: null });
        live.outcome = true;
        live.reviewOnExit = true;
        this.publish(run.taskId);
        return { text: "Report saved. The task moves to review. End your turn now with a short summary of what you built." };
      },
    });

    const submitReview = defineTool({
      name: "submit_review",
      description:
        "Submit your review of the executor's work. approve sends it to the user for merge approval; changes_requested sends the blocking issues back to the executor.",
      schema: ReviewSchema,
      handler: async (review) => {
        const task = this.store.getTask(run.taskId);
        if (task.column !== "review") {
          return { text: "This task is no longer in Review, so no review is needed.", isError: true };
        }
        const plan = this.store.latestPlan(run.taskId);
        const report = this.store.latestExecutionReport(run.taskId);
        if (!plan || !report) return { text: "There is no plan or report to review.", isError: true };
        const expected = plan.plan.acceptanceCriteria.length;
        if (review.criteria.length < expected) {
          return {
            text: `The plan has ${expected} acceptance criteria and your review covers ${review.criteria.length}. Add an entry for each one.`,
            isError: true,
          };
        }

        const cycleRound = task.reviewRound + 1;
        const saved = this.store.addReview(run.taskId, runId, cycleRound, report.version, review);
        this.store.setReviewRound(run.taskId, cycleRound);
        const round = saved.version;
        const blocking = review.issues.filter((i) => i.severity === "blocking");
        live.outcome = true;

        // Running the project's checks can leave files behind (coverage reports, caches). Say so,
        // or the executor's next report is rejected for changes it didn't make.
        const leftovers = task.worktreePath ? await uncommittedChanges(task.worktreePath).catch(() => "") : "";
        const leftoverNote = leftovers
          ? `The review's checks left these files changed or untracked in the worktree:\n\n${leftovers.split("\n").slice(0, 30).join("\n")}`
          : "";
        if (leftoverNote) {
          this.store.addMessage({ taskId: run.taskId, runId, role: "system", kind: "status", text: leftoverNote });
        }

        if (review.verdict === "approve") {
          this.store.addMessage({
            taskId: run.taskId,
            runId,
            role: "agent",
            kind: "review",
            text: `Approved in round ${round}.`,
            data: { reviewVersion: saved.version },
          });
          this.store.moveTask(task.id, { column: "merge_approval", beforeTaskId: null });
          this.publish(run.taskId);
          return { text: "Review saved. The change goes to the user for merge approval. End your turn now with a short summary." };
        }

        this.store.addMessage({
          taskId: run.taskId,
          runId,
          role: "agent",
          kind: "review",
          text: `Requested changes in round ${round}: ${blocking.length} blocking issue${blocking.length === 1 ? "" : "s"}.`,
          data: { reviewVersion: saved.version },
        });

        // Out of rounds: stop the loop and let the user decide.
        if (cycleRound >= MAX_REVIEW_ROUNDS) {
          this.store.setNeedsInput(run.taskId, true);
          this.store.addMessage({
            taskId: run.taskId,
            runId: null,
            role: "system",
            kind: "status",
            text: `The reviewer requested changes ${MAX_REVIEW_ROUNDS} rounds in a row, so Dot stopped the loop. Approve the change as it is, or request changes yourself.`,
          });
          this.publish(run.taskId);
          return { text: "Review saved. The review round limit is reached, so the user decides next. End your turn now with a short summary." };
        }

        const executorRun = this.store.latestRun(run.taskId, "execute");
        if (!executorRun) return { text: "This task has no executor to send the issues to.", isError: true };
        this.store.moveTask(task.id, { column: "execute", beforeTaskId: null });
        // The executor starts once this reviewer's process exits, so the two never share the worktree.
        live.fixOnExit = {
          executorRunId: executorRun.id,
          prompt: [fixRequest(review.issues, round, MAX_REVIEW_ROUNDS - cycleRound), leftoverNote].filter(Boolean).join("\n\n"),
        };
        this.publish(run.taskId);
        return { text: "Review saved. The issues go back to the executor. End your turn now with a short summary." };
      },
    });

    if (run.stage === "research") return [askHuman, submitPlan];
    if (run.stage === "execute") return [askHuman, submitExecutionReport];
    return [askHuman, submitReview];
  }

  // Process management

  private getLive(runId: number): Live {
    let live = this.live.get(runId);
    if (!live) {
      const run = this.store.getRun(runId);
      live = {
        runId,
        taskId: run.taskId,
        token: null,
        process: null,
        expectOutcome: false,
        outcome: false,
        nudged: false,
        costBase: run.costUsd,
        pending: [],
        stopped: false,
        exited: Promise.resolve(),
        resolveExited: () => {},
        refs: null,
        reviewOnExit: false,
        fixOnExit: null,
        stage: run.stage,
      };
      this.live.set(runId, live);
    }
    return live;
  }

  private runningCount(): number {
    let count = 0;
    for (const live of this.live.values()) if (live.process) count++;
    return count;
  }

  private dispatch(runId: number, content: ContentBlock[], expectOutcome: boolean): void {
    const live = this.getLive(runId);
    live.stopped = false;
    live.expectOutcome = expectOutcome;
    if (expectOutcome) {
      live.outcome = false;
      live.nudged = false;
    }

    if (live.process?.acceptingInput) {
      live.process.send(content);
      return;
    }
    live.pending.push(content);
    // A process that is shutting down relaunches with the pending messages when it exits.
    if (live.process || this.queue.includes(runId)) return;

    if (this.runningCount() >= this.config.maxAgents) {
      this.queue.push(runId);
      this.store.updateRun(runId, { status: "queued" });
      this.store.setAgentState(live.taskId, "queued");
      return;
    }
    this.launch(live);
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.runningCount() < this.config.maxAgents) {
      const live = this.getLive(this.queue.shift()!);
      if (live.pending.length > 0) this.launch(live);
    }
  }

  private launch(live: Live): void {
    const run = this.store.getRun(live.runId);
    const task = this.store.getTask(run.taskId);
    const project = this.store.getProject(task.projectId);
    // Outside its own column an agent is only chatting, so it gets read-only tools.
    // That keeps a past-stage agent from touching a worktree another agent is working in.
    const working = task.column === STAGE_COLUMN[run.stage];
    const readOnly: StageConfig = {
      ...STAGE_CONFIG[run.stage],
      tools: RESEARCHER_TOOLS,
      allowedTools: [...RESEARCHER_ALLOWED_TOOLS.filter((t) => !t.startsWith("mcp__")), "mcp__dot__ask_human"],
      deniedTools: RESEARCHER_DENIED_TOOLS,
    };
    const stage: StageConfig =
      run.stage === "research"
        ? STAGE_CONFIG.research
        : !working
          ? readOnly
          : run.stage === "review"
            ? { ...STAGE_CONFIG.review, allowedTools: reviewerAllowedTools(project) }
            : STAGE_CONFIG[run.stage];
    // Claude Code keys sessions by working directory, so each stage must always run in the same place.
    // The executor and reviewer both work in the task's worktree.
    const cwd = run.stage === "research" ? project.repoPath : task.worktreePath;
    if (!cwd) throw new Error("This task has no worktree");

    if (live.token) this.tokens.delete(live.token);
    live.token = randomBytes(24).toString("hex");
    this.tokens.set(live.token, run.id);
    live.costBase = run.costUsd;

    // A session the CLI never started has nothing on disk to resume.
    const resume = run.sessionStarted;
    // A session lives in the config folder it was created in, so a resume must use that folder
    // even if the project has switched accounts since. A fresh session takes the project's current one.
    const configDir = resume ? run.claudeConfigDir : project.claudeConfigDir;
    const tokenName = resume ? run.claudeToken : project.claudeToken;
    if (tokenName && !claudeTokenFor(tokenName)) {
      throw new Error(`This project uses the Claude token "${tokenName}", but DOT_CLAUDE_TOKEN_${tokenName} is not set on the server.`);
    }
    if (!resume) this.store.setRunAccount(run.id, configDir, tokenName);

    this.store.updateRun(run.id, { status: "running", error: null });
    this.store.setAgentState(task.id, "running");

    live.exited = new Promise((resolve) => (live.resolveExited = resolve));
    // The executor, and the reviewer through the project's commands, run code from the task branch,
    // so both are audited while working. The snapshot runs while the CLI starts up, which takes
    // far longer than reading refs.
    live.refs = run.stage !== "research" && working ? snapshotRefs(project.repoPath).catch(() => null) : null;
    live.stage = run.stage;

    const process = new ClaudeProcess(
      {
        cwd,
        sessionId: run.sessionId,
        resume,
        model: this.config.model,
        appendSystemPrompt: stage.systemPrompt,
        tools: stage.tools,
        allowedTools: stage.allowedTools,
        deniedTools: [...stage.deniedTools, ...this.config.guardRules],
        mcpUrl: `http://127.0.0.1:${this.config.port}/api/mcp/${live.token}`,
        configDir,
        tokenName,
      },
      {
        onEvent: (event) => this.safely(task.id, () => this.onEvent(live, event, cwd)),
        onTurnEnd: () => {
          this.safely(task.id, () => this.onTurnEnd(live));
          void this.auditRefs(live, project.repoPath, task.branch);
        },
        onExit: (info) => {
          this.safely(task.id, () => this.onExit(live, info));
          void this.auditRefs(live, project.repoPath, task.branch).finally(() => live.resolveExited());
        },
      },
    );
    live.process = process;
    for (const content of live.pending.splice(0)) process.send(content);
    this.publish(task.id);
  }

  // Compares the repo's refs with the snapshot from launch (or the last audit) and flags anything
  // the executor changed outside its own branch: other branches, tags, the main checkout's HEAD,
  // or remote-tracking refs (which move when it pushes or fetches).
  // Audits are chained through live.refs, so the turn-end and exit audits never compare against
  // the same snapshot and report one change twice.
  private auditRefs(live: Live, repo: string, branch: string | null): Promise<void> {
    if (!live.refs || !branch) return Promise.resolve();
    const previous = live.refs;
    let settle: (snapshot: RefSnapshot | null) => void = () => {};
    live.refs = new Promise((resolve) => (settle = resolve));

    return (async () => {
      const before = await previous;
      if (!before) return settle(null);
      let after: RefSnapshot;
      try {
        after = await snapshotRefs(repo);
      } catch (err) {
        console.error(`Ref audit for task ${live.taskId} failed:`, err);
        return settle(before);
      }
      settle(after);

      const projectId = this.store.getTask(live.taskId).projectId;
      const changes = refChanges(before, after, [branch, ...this.store.listTaskBranches(projectId)]);
      if (changes.length === 0) return;
      this.safely(live.taskId, () => {
        this.store.setNeedsInput(live.taskId, true);
        this.store.addMessage({
          taskId: live.taskId,
          runId: live.runId,
          role: "system",
          kind: "error",
          text:
            `While the ${STAGE_LABELS[live.stage].toLowerCase()} worked, the repository changed outside the task branch ${branch}. ` +
            `If you didn't make these changes yourself, check them and undo what you don't want:\n\n` +
            changes.map((c) => `- ${c}`).join("\n"),
        });
        this.publish(live.taskId);
      });
    })();
  }

  private onEvent(live: Live, event: StreamEvent, cwd: string): void {
    if (event.type === "system" && event.subtype === "init") {
      this.store.markSessionStarted(live.runId);
      return;
    }

    if (event.type === "assistant") {
      const blocks = ((event.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      let changed = false;
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "agent", kind: "text", text: block.text.trim() });
          changed = true;
        } else if (block.type === "tool_use" && typeof block.name === "string" && !block.name.startsWith("mcp__dot__")) {
          this.store.addMessage({
            taskId: live.taskId,
            runId: live.runId,
            role: "tool",
            kind: "tool",
            text: describeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>, cwd),
            data: { tool: block.name },
          });
          changed = true;
        }
      }
      if (changed) this.bus.publish({ type: "messages.changed", taskId: live.taskId });
      return;
    }

    // Failed tool calls, including denied permissions, so you can see what the agent tried.
    if (event.type === "user") {
      const blocks = ((event.message as { content?: unknown })?.content ?? []) as unknown;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks as Record<string, unknown>[]) {
        if (block.type !== "tool_result" || block.is_error !== true) continue;
        const text = toolResultText(block.content);
        this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "tool", kind: "error", text });
        this.bus.publish({ type: "messages.changed", taskId: live.taskId });
      }
      return;
    }

    if (event.type === "result") {
      const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;
      this.store.updateRun(live.runId, { costUsd: live.costBase + cost });
      if (event.is_error === true) {
        const detail = typeof event.result === "string" && event.result ? event.result : String(event.subtype ?? "error");
        this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "system", kind: "error", text: detail });
        this.bus.publish({ type: "messages.changed", taskId: live.taskId });
      }
    }
  }

  private onTurnEnd(live: Live): void {
    if (live.stopped || !live.expectOutcome || live.outcome) return;
    const run = this.store.getRun(live.runId);
    if (this.store.getTask(live.taskId).column !== STAGE_COLUMN[run.stage]) return;

    if (!live.nudged) {
      live.nudged = true;
      live.process?.send([{ type: "text", text: STAGE_CONFIG[run.stage].nudge }]);
      return;
    }
    live.expectOutcome = false;
    this.store.setNeedsInput(live.taskId, true);
    this.store.addMessage({
      taskId: live.taskId,
      runId: live.runId,
      role: "system",
      kind: "status",
      text: STAGE_CONFIG[run.stage].stalled,
    });
    this.publish(live.taskId);
  }

  private onExit(live: Live, info: { code: number | null; stderr: string; sawResult: boolean }): void {
    live.process = null;
    if (live.token) this.tokens.delete(live.token);
    live.token = null;

    let failed = false;
    if (live.stopped) {
      this.store.updateRun(live.runId, { status: "idle" });
      this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "system", kind: "status", text: "Stopped." });
    } else if (!info.sawResult && info.code !== 0) {
      failed = true;
      const detail = info.stderr || `The claude process exited with code ${info.code}.`;
      this.store.updateRun(live.runId, { status: "failed", error: detail });
      this.store.setNeedsInput(live.taskId, true);
      this.store.addMessage({
        taskId: live.taskId,
        runId: live.runId,
        role: "system",
        kind: "error",
        text: `The agent could not run.\n\n${detail}`,
      });
    } else {
      this.store.updateRun(live.runId, { status: "idle" });
    }

    if (!live.stopped && !failed && live.pending.length > 0) {
      // Messages arrived while the process was shutting down.
      if (this.runningCount() < this.config.maxAgents) this.launch(live);
      else {
        this.queue.push(live.runId);
        this.store.updateRun(live.runId, { status: "queued" });
        this.store.setAgentState(live.taskId, "queued");
      }
    } else {
      const task = this.store.getTask(live.taskId);
      this.store.setAgentState(live.taskId, failed ? "failed" : task.needsInput ? "waiting" : "idle");
    }

    // The executor's report was accepted and its process is gone, so the worktree is free for the reviewer.
    if (live.reviewOnExit) {
      live.reviewOnExit = false;
      if (!live.stopped && this.store.getTask(live.taskId).column === "review") {
        this.startReview(live.taskId).catch((err: unknown) =>
          this.safely(live.taskId, () => {
            this.store.addMessage({
              taskId: live.taskId,
              runId: null,
              role: "system",
              kind: "error",
              text: `Could not start the reviewer: ${err instanceof Error ? err.message : String(err)}`,
            });
            this.publish(live.taskId);
          }),
        );
      }
    }

    // The reviewer requested changes and its process is gone, so the executor can take the worktree.
    if (live.fixOnExit) {
      const { executorRunId, prompt } = live.fixOnExit;
      live.fixOnExit = null;
      if (!live.stopped && this.store.getTask(live.taskId).column === "execute") {
        this.dispatch(executorRunId, [{ type: "text", text: prompt }], true);
      }
    }

    this.drainQueue();
    this.publish(live.taskId);
  }

  // A handler error must never crash the server, for example when a task is deleted mid-run.
  private safely(taskId: number, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`Agent event for task ${taskId} failed:`, err);
    }
  }

  private publish(taskId: number): void {
    try {
      const task = this.store.getTask(taskId);
      this.bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId });
      this.bus.publish({ type: "messages.changed", taskId });
    } catch {
      // The task was deleted. Nothing to publish.
    }
  }

  runsFor(taskId: number): Run[] {
    return this.store.listRuns(taskId);
  }
}

function buildContent(text: string, attachments: Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text });
  for (const a of attachments) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: a.mediaType, data: readFileSync(a.path).toString("base64") },
    });
  }
  return blocks;
}

function toolResultText(content: unknown): string {
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n")
    : String(content ?? "");
  return text.length > 600 ? `${text.slice(0, 597)}...` : text || "Tool call failed.";
}
