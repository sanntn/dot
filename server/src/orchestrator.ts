import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLUMN_LABELS,
  MAX_REVIEW_ROUNDS,
  defaultTaskKind,
  kindDef,
  planSubtaskProblem,
  previewPathProblem,
  type TaskKind,
  stageColumn,
  stageLabel,
  type AgentStage,
  type ChatMessage,
  type Column,
  type Plan,
  type PlanArtifact,
  type PlanSplit,
  type ProposalDecide,
  type ProposalDecision,
  type ProposalsArtifact,
  type Project,
  type Run,
  type Task,
} from "@dot/shared";
import { ClaudeProcess, claudeTokenFor, describeToolUse, type ContentBlock, type StreamEvent } from "./agents/claude.ts";
import {
  RESEARCHER_ALLOWED_TOOLS,
  RESEARCHER_DENIED_TOOLS,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
  researcherBrief,
} from "./agents/researcher.ts";
import {
  REPORTER_ALLOWED_TOOLS,
  REPORTER_DENIED_TOOLS,
  REPORTER_SYSTEM_PROMPT,
  REPORTER_TOOLS,
  reporterBrief,
} from "./agents/reporter.ts";
import {
  TRIAGER_ALLOWED_TOOLS,
  TRIAGER_DENIED_TOOLS,
  TRIAGER_SYSTEM_PROMPT,
  TRIAGER_TOOLS,
  triagerBrief,
} from "./agents/triager.ts";
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
import { checkCommands, checksSummary, runChecks, type CheckResult } from "./checks.ts";
import { HttpError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { trustedOrigin } from "./githost.ts";
import {
  branchSlug,
  excludeFromGit,
  fetchBase,
  resolveBaseRef,
  gitError,
  prepareWorktree,
  refChanges,
  removeWorktree,
  snapshotRefs,
  type RefSnapshot,
  type Workspace,
} from "./git.ts";
import { agentTools } from "./agentTools.ts";
import { MergeStep } from "./merge.ts";
import { capturePreview, PREVIEW_SETUP_HINT, previewMode } from "./preview.ts";
import { handleMcp, type McpTool } from "./mcp.ts";
import type { Attachment, Store } from "./store.ts";

export type OrchestratorConfig = {
  port: number;
  maxAgents: number;
  model: string;
  worktreesDir: string;
  // Where chat images live. Previews are saved here as images. Without it, previews are off.
  attachmentsDir?: string;
  // Deny rules every agent gets, see agents/guards.ts.
  guardRules: string[];
  // An agent mid-turn that sends nothing for this long is stopped and flagged. 0 turns the check off.
  stuckAfterMs?: number;
  // How often the check runs.
  stuckCheckMs?: number;
  // Longest a single project check may run. Defaults to 10 minutes.
  checkTimeoutMs?: number;
};

// Sent when a research-stage turn ends without its submit tool or a question.
const researchNudge = (submit: string) =>
  `You ended your turn without calling ${submit} or ask_human. Continue the research. ` +
  `When you are ready, call ${submit}. If you need a decision from the user, call ask_human.`;

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
    nudge: researchNudge("submit_plan"),
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

// The report kind has one agent. It takes the researcher's place and submits a report instead of a plan.
const REPORT_CONFIG: StageConfig = {
  tools: REPORTER_TOOLS,
  allowedTools: REPORTER_ALLOWED_TOOLS,
  deniedTools: REPORTER_DENIED_TOOLS,
  systemPrompt: REPORTER_SYSTEM_PROMPT,
  nudge: researchNudge("submit_report"),
  stalled: "The report agent stopped without a report or a question. Reply here to tell it how to continue.",
};

// The triage kind also has one agent, which proposes tasks instead of writing a plan.
const TRIAGE_CONFIG: StageConfig = {
  tools: TRIAGER_TOOLS,
  allowedTools: TRIAGER_ALLOWED_TOOLS,
  deniedTools: TRIAGER_DENIED_TOOLS,
  systemPrompt: TRIAGER_SYSTEM_PROMPT,
  nudge: researchNudge("submit_proposals"),
  stalled: "The triage agent stopped without proposals or a question. Reply here to tell it how to continue.",
};

// The research-stage agent of each kind: its settings and what it reads first. A new kind adds a row here.
const RESEARCH_AGENTS: Record<TaskKind, { config: StageConfig; brief: (task: Task, project: Project, rules: string[], memory: string[]) => string }> = {
  code: { config: STAGE_CONFIG.research, brief: researcherBrief },
  report: { config: REPORT_CONFIG, brief: reporterBrief },
  triage: { config: TRIAGE_CONFIG, brief: triagerBrief },
};

// The stage's settings for a kind of task. Kinds only change the research stage.
function stageConfig(kind: TaskKind, stage: AgentStage): StageConfig {
  return stage === "research" ? (RESEARCH_AGENTS[kind] ?? RESEARCH_AGENTS.code).config : STAGE_CONFIG[stage];
}

// What a research-stage agent reads first, by kind.
function researchBrief(task: Task, project: Project, rules: string[], memory: string[]): string {
  return (RESEARCH_AGENTS[task.kind] ?? RESEARCH_AGENTS.code).brief(task, project, rules, memory);
}

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
  // Messages sent to the process whose turn has not ended yet. Each message gets its own turn, so a
  // message sent mid-turn must not make the earlier turn's end look like a stall.
  turnsInFlight: number;
  // When the process last sent an event or was last given a message.
  lastActivity: number;
  costBase: number;
  // Messages that arrived while no process could take them. The next launch sends them.
  pending: ContentBlock[][];
  stopped: boolean;
  // Set when Dot stopped the agent and already said why, so the exit does not add a plain "Stopped."
  quietStop: boolean;
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
  private readonly mergeStep: MergeStep;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly config: OrchestratorConfig,
  ) {
    this.startStuckWatch();
    // Any board change may have finished a blocker, so look for tasks that can start.
    // Agents publish often, so one pending check covers a burst of events.
    this.unsubscribeBus = bus.subscribe((event) => {
      if (event.type !== "tasks.changed" || this.unblockPending) return;
      this.unblockPending = true;
      setImmediate(() => {
        this.unblockPending = false;
        this.startUnblocked();
      });
    });
    this.mergeStep = new MergeStep(store, {
      publish: (taskId) => this.publish(taskId),
      stop: (taskId) => this.stop(taskId),
      resumeExecutor: (runId, prompt) => this.dispatch(runId, [{ type: "text", text: prompt }], true),
    });
  }

  // Public actions

  async startMerge(taskId: number, options: { skipCi: boolean }): Promise<Task> {
    // The merge removes the worktree, so a preview still using it stops, and is gone, first.
    const preview = this.previewAborts.get(taskId);
    if (preview) {
      preview.abort.abort();
      await preview.done;
    }
    return this.mergeStep.start(taskId, options);
  }

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
    return this.beginResearch(task, project, "Research started.");
  }

  // A new researcher run with a new session.
  private beginResearch(task: Task, project: Project, note: string): Task {
    this.store.setNeedsInput(task.id, false);
    const run = this.store.createRun(task.id, "research", randomUUID());
    this.store.addMessage({ taskId: task.id, runId: run.id, role: "system", kind: "status", text: note });
    this.dispatch(run.id, buildContent(researchBrief(task, project, this.store.activeRules(project.id), this.store.memoryNotes(project.id)), this.store.taskAttachments(task.id)), true);
    this.publish(task.id);
    return this.store.getTask(task.id);
  }

  // Throws away an agent's session and starts that stage again with a new one. For a stage that went
  // wrong in a way a message cannot fix, such as an agent stuck on a wrong idea. Earlier plans, reports
  // and reviews stay. The task's branch and worktree stay too, so a new executor continues from the commits.
  async retryFrom(taskId: number, stage: AgentStage): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column === "inbox" || task.column === "done") throw new HttpError(409, "This task has no stage to retry");
    if (this.mergeStep.isRunning(taskId)) throw new HttpError(409, "Stop the merge before retrying a stage");
    if (!this.store.latestRun(taskId, stage)) throw new HttpError(409, `The ${stageLabel(task.kind, stage).toLowerCase()} has not started yet`);
    if (stage === "execute" && !this.store.latestPlan(taskId)) throw new HttpError(409, "This task has no approved plan");
    if (stage === "review" && !this.store.latestExecutionReport(taskId)) throw new HttpError(409, "This task has no execution report to review");
    if (stage !== "research" && (!task.worktreePath || !existsSync(task.worktreePath))) {
      throw new HttpError(409, "The worktree was removed, so only the researcher can run again");
    }
    const project = this.store.getProject(task.projectId);

    await this.stop(taskId);
    this.checksFixed.delete(taskId);
    // A retry starts a new cycle, like your own change request does.
    if (stage !== "review") this.store.setReviewRound(taskId, 0);
    // Redoing a review of the same report must not use up one of the rounds before the loop stops.
    else if (this.store.latestReview(taskId)?.reportVersion === this.store.latestExecutionReport(taskId)?.version) {
      this.store.setReviewRound(taskId, Math.max(0, task.reviewRound - 1));
    }
    const stageCol = stageColumn(task.kind, stage);
    if (!stageCol) throw new HttpError(409, `A ${kindDef(task.kind).label.toLowerCase()} has no ${stageLabel(task.kind, stage).toLowerCase()} stage`);
    if (task.column !== stageCol) this.store.moveTask(taskId, { column: stageCol, beforeTaskId: null });
    const note = `Retrying the ${stageLabel(task.kind, stage).toLowerCase()} with a new session.`;
    if (stage === "research") return this.beginResearch(this.store.getTask(taskId), project, note);
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: note });
    return stage === "execute" ? this.startExecution(taskId, { fresh: true }) : this.startReview(taskId, { fresh: true });
  }

  // Picks the researcher up again after a Stop or a stall, in its existing session.
  resumeResearch(taskId: number): Task {
    const task = this.store.getTask(taskId);
    if (task.column !== "research") throw new HttpError(409, "Only a task in Research can resume the researcher");
    const run = this.store.latestRun(taskId, "research");
    if (!run) throw new HttpError(409, "This task has no researcher yet");
    if (run.status === "running" || run.status === "queued") throw new HttpError(409, "The researcher is already running");

    this.store.setNeedsInput(taskId, false);
    this.store.addMessage({ taskId, runId: run.id, role: "system", kind: "status", text: `${stageLabel(task.kind, "research")} resumed.` });
    const content: ContentBlock[] = run.sessionStarted
      ? [{ type: "text", text: `Continue the research. When you are ready, call ${kindDef(task.kind).submitTool}. If you need a decision from the user, call ask_human.` }]
      : buildContent(researchBrief(task, this.store.getProject(task.projectId), this.store.activeRules(task.projectId), this.store.memoryNotes(task.projectId)), this.store.taskAttachments(taskId));
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
        `The ${stageLabel(task.kind, input.stage).toLowerCase()} can't run anymore: its worktree was removed when the task was merged. The researcher is still available.`,
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

    const expectOutcome = task.column === stageColumn(task.kind, input.stage);
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
  // With fresh, the executor gets a new run and session instead of resuming the old one.
  async startExecution(taskId: number, options: { fresh?: boolean } = {}): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "execute") throw new HttpError(409, "Only a task in Execute can start the executor");
    const plan = this.store.latestPlan(taskId);
    if (!plan) throw new HttpError(409, "This task has no approved plan");
    const latest = this.store.latestRun(taskId, "execute");
    if (this.starting.has(taskId) || (latest && (latest.status === "running" || latest.status === "queued"))) {
      throw new HttpError(409, "The executor is already running");
    }
    const existing = options.fresh ? null : latest;
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

    const brief = executorBrief(this.store.getTask(taskId), project, plan.plan, plan.version, branch, this.store.activeRules(project.id), this.store.memoryNotes(project.id));
    const prompt = run.sessionStarted
      ? "Continue implementing the approved plan. When the work is committed, call submit_execution_report."
      : latest && options.fresh
        ? `${brief}\n\nAnother executor already worked on this branch and its session was discarded. Read \`git log\` and \`git diff\` against the base first, keep what is right, and fix what is not.`
        : brief;
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
  // With fresh, the reviewer gets a new run and session, and may review a report that already has a review.
  async startReview(taskId: number, options: { fresh?: boolean } = {}): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "review") throw new HttpError(409, "Only a task in Review can start the reviewer");
    const plan = this.store.latestPlan(taskId);
    const report = this.store.latestExecutionReport(taskId);
    if (!plan || !report) throw new HttpError(409, "This task has no execution report to review");
    const latest = this.store.latestRun(taskId, "review");
    if (this.starting.has(taskId) || (latest && (latest.status === "running" || latest.status === "queued"))) {
      throw new HttpError(409, "The reviewer is already running");
    }
    const existing = options.fresh ? null : latest;
    if (!options.fresh && !this.reviewPending(taskId)) {
      throw new HttpError(409, "The latest report is already reviewed. Approve it, or request changes.");
    }
    const round = (this.store.latestReview(taskId)?.version ?? 0) + 1;
    const project = this.store.getProject(task.projectId);

    // The reviewer diffs against the same base the executor's branch started from.
    this.starting.add(taskId);
    let baseRef: string;
    let checks: CheckResult[] = [];
    try {
      baseRef = await resolveBaseRef(project.repoPath, project.baseBranch);
      // The project's own commands run first, so the reviewer starts from known results.
      if (task.worktreePath && existsSync(task.worktreePath) && checkCommands(project).length > 0) {
        const ran = await this.runProjectChecks(task, project);
        // Stopped, or moved on by you while the commands ran. No reviewer starts.
        if (ran === null || this.store.getTask(taskId).column !== "review") return this.store.getTask(taskId);
        checks = ran;
        if (checks.some((c) => !c.ok) && !this.checksFixed.has(taskId) && this.sendChecksBack(taskId, checks)) {
          return this.store.getTask(taskId);
        }
        if (checks.every((c) => c.ok)) this.checksFixed.delete(taskId);
      }
    } finally {
      this.starting.delete(taskId);
    }

    this.store.setNeedsInput(taskId, false);
    const run = existing ?? this.store.createRun(taskId, "review", randomUUID());
    this.store.addMessage({ taskId, runId: run.id, role: "system", kind: "status", text: `Review round ${round} started.` });
    const prompt = run.sessionStarted
      ? reviewerFollowUp(report, round, baseRef, checks)
      : reviewerBrief(this.store.getTask(taskId), project, plan.plan, plan.version, report, round, baseRef, checks, this.store.activeRules(project.id), this.store.memoryNotes(project.id));
    this.dispatch(run.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // Tasks whose failed checks already went back to the executor once. A second failure goes to the
  // reviewer as evidence, so the pair cannot loop on a check that never passes.
  private readonly checksFixed = new Set<number>();
  // The project checks running for a task, so Stop can end them.
  private readonly checkAborts = new Map<number, AbortController>();
  // A running preview: abort stops it, and done settles once its dev server and browser are gone.
  private readonly previewAborts = new Map<number, { abort: AbortController; done: Promise<void> }>();

  // Runs the project's test, lint and typecheck commands in the task's worktree and posts the results.
  // Null when a Stop ended the run.
  private async runProjectChecks(task: Task, project: Project): Promise<CheckResult[] | null> {
    const names = checkCommands(project).map((c) => c.name).join(", ");
    this.store.addMessage({ taskId: task.id, runId: null, role: "system", kind: "status", text: `Running the project checks (${names}) before the review.` });
    this.store.setAgentState(task.id, "running");
    this.publish(task.id);

    const before = await snapshotRefs(project.repoPath).catch(() => null);
    const abort = new AbortController();
    this.checkAborts.set(task.id, abort);
    let results: CheckResult[];
    try {
      results = await runChecks(project, task.worktreePath!, this.config.checkTimeoutMs, abort.signal);
    } finally {
      this.checkAborts.delete(task.id);
      this.store.setAgentState(task.id, "idle");
    }
    if (abort.signal.aborted) {
      this.store.addMessage({ taskId: task.id, runId: null, role: "system", kind: "status", text: "Stopped the project checks." });
      this.publish(task.id);
      return null;
    }
    const after = before ? await snapshotRefs(project.repoPath).catch(() => null) : null;

    this.store.addMessage({ taskId: task.id, runId: null, role: "system", kind: "status", text: `Project checks:

${checksSummary(results)}` });
    if (before && after && task.branch) {
      const changes = refChanges(before, after, [task.branch, ...this.store.listTaskBranches(project.id)]);
      if (changes.length > 0) {
        this.store.setNeedsInput(task.id, true);
        this.store.addMessage({
          taskId: task.id,
          runId: null,
          role: "system",
          kind: "error",
          text:
            `While the project checks ran, the repository changed outside the task branch ${task.branch}. ` +
            `If you didn't make these changes yourself, check them and undo what you don't want:\n\n` +
            changes.map((c) => `- ${c}`).join("\n"),
        });
      }
    }
    this.publish(task.id);
    return results;
  }

  // Failed checks go back to the executor before a reviewer spends anything on them.
  private sendChecksBack(taskId: number, checks: CheckResult[]): boolean {
    const executor = this.store.latestRun(taskId, "execute");
    if (!executor) return false;
    this.checksFixed.add(taskId);
    this.store.moveTask(taskId, { column: "execute", beforeTaskId: null });
    this.store.setNeedsInput(taskId, false);
    this.store.addMessage({
      taskId,
      runId: executor.id,
      role: "system",
      kind: "status",
      text: "Some project checks failed, so the task goes back to the executor before the review.",
    });
    const prompt = [
      "Dot ran the project commands after your report, and some failed. Fix the failures, commit, and call submit_execution_report again.",
      "",
      checksSummary(checks.filter((c) => !c.ok)),
    ].join("\n");
    this.dispatch(executor.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
    return true;
  }

  // Your override in Review: accept the change without (another) agent review.
  async approveReview(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "review") throw new HttpError(409, "Only a task in Review can be approved");
    await this.stop(taskId);
    this.requireColumn(taskId, "review");
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
    if (this.mergeStep.isRunning(taskId)) throw new HttpError(409, "Stop the merge before requesting changes");
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


  // Removes a task's worktree folder before the task is deleted. The branch stays in the repo.
  // Call after stop() has resolved: on Windows a running process keeps its folder locked.
  async cleanupWorkspace(taskId: number): Promise<void> {
    this.checksFixed.delete(taskId);
    const task = this.store.getTask(taskId);
    if (!task.worktreePath) return;
    const project = this.store.getProject(task.projectId);
    await removeWorktree(project.repoPath, task.worktreePath);
  }

  sendBack(taskId: number, notes: string): Task {
    return this.reviseResearch(taskId, { gate: "plan_review", what: "plan", submit: "submit_plan", notes });
  }

  // A report task: you read the report and approve it, which finishes the task.
  async approveReportDoc(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.kind !== "report" || task.column !== "report_review") {
      throw new HttpError(409, "Only a report in Report review can be approved");
    }
    const doc = this.store.latestReportDoc(taskId);
    if (!doc) throw new HttpError(409, "This task has no report yet");
    // The agent may still be answering a chat message. Approving ends its work, like approving a review does.
    await this.stop(taskId);
    this.requireColumn(taskId, "report_review");
    this.store.moveTask(taskId, { column: "done", beforeTaskId: null });
    this.store.setNeedsInput(taskId, false);
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: `Report v${doc.version} approved.` });
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  sendBackReportDoc(taskId: number, notes: string): Task {
    const task = this.store.getTask(taskId);
    if (task.kind !== "report") throw new HttpError(409, "Only a report task has a report to send back");
    return this.reviseResearch(taskId, { gate: "report_review", what: "report", submit: "submit_report", notes });
  }

  // A triage task: you accept or reject each proposed task. Accepting creates the task in the Inbox of
  // this project, and nothing starts by itself.
  decideProposals(taskId: number, input: ProposalDecide): ProposalsArtifact {
    const task = this.store.getTask(taskId);
    if (task.kind !== "triage" || task.column !== "triage_review") {
      throw new HttpError(409, "Proposals can be decided while they wait in Triage review");
    }
    const latest = this.store.latestProposals(taskId);
    if (!latest) throw new HttpError(409, "This task has no proposals yet");
    // The agent may have submitted a newer version while you were reading this one.
    if (latest.version !== input.version) throw new HttpError(409, "The agent submitted new proposals. Reload and decide again.");

    const items = latest.proposals.items;
    const indexes = [...input.accept, ...input.reject];
    if (new Set(indexes).size !== indexes.length) throw new HttpError(400, "An item can only be decided once per request");
    for (const i of indexes) {
      if (items[i]?.action !== "create_task") throw new HttpError(400, `Item ${i + 1} is not a proposed task`);
      if (latest.decisions[i]) throw new HttpError(409, `Item ${i + 1} is already decided`);
    }

    const project = this.store.getProject(task.projectId);
    const defaultKind = defaultTaskKind(project.kind);
    const decided: Record<number, ProposalDecision> = {};
    const created: [number, number][] = [];
    let failure: unknown = null;
    for (const i of input.accept) {
      const item = items[i]!;
      try {
        const made = this.store.createTask({
          projectId: task.projectId,
          title: item.title,
          description: item.description ?? item.reason,
          kind: item.taskKind ?? defaultKind,
          blockedBy: [],
          autoStart: false,
        });
        created.push([i, made.id]);
        decided[i] = { status: "accepted", taskId: made.id };
      } catch (err) {
        // Keep the tasks already made on record, or accepting again would duplicate them.
        failure = err;
        break;
      }
    }
    if (!failure) for (const i of input.reject) decided[i] = { status: "rejected", taskId: null };

    if (Object.keys(decided).length > 0) this.store.addProposalDecisions(taskId, latest.version, decided);
    if (failure) {
      for (const [, id] of created) this.publish(id);
      this.publish(taskId);
      throw failure;
    }
    const parts = [
      created.length > 0 ? `${created.length} ${created.length === 1 ? "task" : "tasks"} created in the Inbox` : "",
      input.reject.length > 0 ? `${input.reject.length} rejected` : "",
    ].filter(Boolean);
    if (parts.length > 0) {
      this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: `Triage: ${parts.join(", ")}.` });
    }
    for (const [, id] of created) this.publish(id);
    this.publish(taskId);
    return this.store.latestProposals(taskId)!;
  }

  // Finishes a triage task. Proposed tasks you left undecided are dropped.
  async finishTriage(taskId: number): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.kind !== "triage" || task.column !== "triage_review") {
      throw new HttpError(409, "Only a triage task in Triage review can be finished");
    }
    const latest = this.store.latestProposals(taskId);
    if (!latest) throw new HttpError(409, "This task has no proposals yet");
    await this.stop(taskId);
    this.requireColumn(taskId, "triage_review");
    const open = latest.proposals.items.filter((item, i) => item.action === "create_task" && !latest.decisions[i]).length;
    this.store.moveTask(taskId, { column: "done", beforeTaskId: null });
    this.store.setNeedsInput(taskId, false);
    this.store.addMessage({
      taskId,
      runId: null,
      role: "system",
      kind: "status",
      text: open > 0 ? `Triage finished. ${open} undecided ${open === 1 ? "proposal was" : "proposals were"} dropped.` : "Triage finished.",
    });
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  sendBackProposals(taskId: number, notes: string): Task {
    const task = this.store.getTask(taskId);
    if (task.kind !== "triage") throw new HttpError(409, "Only a triage task has proposals to send back");
    return this.reviseResearch(taskId, { gate: "triage_review", what: "proposals", submit: "submit_proposals", notes });
  }

  // Sends a plan or report back to the research-stage agent with your notes. The agent resumes its session.
  private reviseResearch(taskId: number, o: { gate: Column; what: string; submit: string; notes: string }): Task {
    const task = this.store.getTask(taskId);
    const label = o.what[0]!.toUpperCase() + o.what.slice(1);
    if (task.column !== o.gate) throw new HttpError(409, `Only a task in ${COLUMN_LABELS[o.gate]} can be sent back`);
    const run = this.store.latestRun(taskId, "research");
    if (!run) throw new HttpError(409, `This task has no ${stageLabel(task.kind, "research").toLowerCase()}`);

    this.store.moveTask(taskId, { column: "research", beforeTaskId: null });
    // Sending notes answers whatever the agent asked, so the flag no longer applies.
    if (task.needsInput) this.store.setNeedsInput(taskId, false);
    this.store.addMessage({ taskId, runId: run.id, role: "user", kind: "text", text: `Sent the ${o.what} back:\n\n${o.notes}` });
    const prompt = `The user sent the ${o.what} back for changes:\n\n${o.notes}\n\nRevise the ${o.what} and submit it again with ${o.submit}.`;
    this.dispatch(run.id, [{ type: "text", text: prompt }], true);
    this.publish(taskId);
    return this.store.getTask(taskId);
  }

  // Moves some steps of a big plan into a new task. The new task waits for this one and starts its research
  // by itself afterwards. This task's plan loses those steps, so the executor stays on what is left.
  splitPlan(taskId: number, input: PlanSplit): { task: Task; plan: PlanArtifact } {
    const task = this.store.getTask(taskId);
    // Not in Research: a researcher that is still working would submit a new plan with every step again.
    if (task.column !== "plan_review") throw new HttpError(409, "A plan can be split while it waits in Plan review");
    const latest = this.store.latestPlan(taskId);
    if (!latest) throw new HttpError(409, "This task has no plan yet");
    const picked = [...new Set(input.steps)].sort((a, b) => a - b);
    const { plan } = latest;
    if (picked.some((i) => i >= plan.steps.length)) throw new HttpError(400, "A picked step does not exist");
    if (picked.length >= plan.steps.length) throw new HttpError(400, "Leave at least one step in this task");

    const moved = picked.map((i) => plan.steps[i]!);
    const kept = plan.steps.filter((_, i) => !picked.includes(i));
    const description = [
      `Split from #${task.number}, ${task.title}. That task finishes first, and this one builds on its branch's merge.`,
      `Goal of #${task.number}: ${plan.goal}`,
      `Steps for this task:\n${moved.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      plan.context.trim() ? `Context found while planning #${task.number}:\n${plan.context.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const created = this.store.createTask({
      projectId: task.projectId,
      title: input.title,
      description,
      kind: task.kind,
      blockedBy: [taskId],
      autoStart: true,
    });
    const saved = this.store.addPlan(taskId, null, "user", {
      ...plan,
      steps: kept,
      // Its step positions no longer match.
      subtasks: undefined,
      assumptions: [...plan.assumptions, `${moved.length === 1 ? "One step is" : `${moved.length} steps are`} left to #${created.number}, ${created.title}.`],
    });
    this.store.addMessage({
      taskId,
      runId: null,
      role: "system",
      kind: "status",
      text: `Split ${moved.length === 1 ? "one step" : `${moved.length} steps`} into #${created.number}, ${created.title}. It starts after this task is done. You edited the plan (v${saved.version}).`,
    });
    this.publish(taskId);
    this.bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: created.id });
    return { task: created, plan: saved };
  }

  // Starts the task's dev server in its worktree, takes a picture of the page and posts it in the chat.
  // It runs in the background: starting a dev server can take a minute.
  startPreview(taskId: number): Task {
    const task = this.store.getTask(taskId);
    const attachmentsDir = this.config.attachmentsDir;
    if (!attachmentsDir) throw new HttpError(409, "Previews are not set up on this server");
    if (task.column !== "merge_approval") throw new HttpError(409, "A preview is taken while the change waits for merge approval");
    if (!task.worktreePath || !existsSync(task.worktreePath)) throw new HttpError(409, "The worktree was removed, so there is nothing to preview");
    if (this.previewAborts.has(taskId)) throw new HttpError(409, "A preview is already running");
    const project = this.store.getProject(task.projectId);
    if (!previewMode(project)) throw new HttpError(409, PREVIEW_SETUP_HINT);

    const abort = new AbortController();
    let finished!: () => void;
    this.previewAborts.set(taskId, { abort, done: new Promise<void>((resolve) => (finished = resolve)) });
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: "Starting the dev server for a preview." });
    this.publish(taskId);
    const worktree = task.worktreePath;
    void (async () => {
      try {
        const result = await capturePreview(project, worktree, abort.signal);
        if (abort.signal.aborted) {
          this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: "The preview was stopped." });
          return;
        }
        if (!result.ok) {
          this.store.addMessage({ taskId, runId: null, role: "system", kind: "error", text: `The preview failed.

${result.error}` });
          return;
        }
        const dir = join(attachmentsDir, String(taskId));
        mkdirSync(dir, { recursive: true });
        const fileName = `preview-${Date.now()}.png`;
        const path = join(dir, fileName);
        writeFileSync(path, result.png);
        const saved = this.store.addAttachment({ taskId, fileName, mediaType: "image/png", size: result.png.length, path, origin: "chat" });
        this.store.addMessage({
          taskId,
          runId: null,
          role: "system",
          kind: "status",
          text: result.note,
          data: { attachments: [{ id: saved.id, fileName: saved.fileName, mediaType: saved.mediaType }] },
        });
      } catch (err) {
        this.store.addMessage({ taskId, runId: null, role: "system", kind: "error", text: `The preview failed.

${err instanceof Error ? err.message : String(err)}` });
      } finally {
        this.previewAborts.delete(taskId);
        finished();
        this.publish(taskId);
      }
    })();
    return this.store.getTask(taskId);
  }

  // Turns the plan's suggested subtasks into separate tasks. Each one researches and builds on its own, so
  // tasks with no blocker run side by side, up to the agent limit. This task has nothing left to do, so it is closed.
  splitIntoSubtasks(taskId: number): Task[] {
    const task = this.store.getTask(taskId);
    if (task.column !== "plan_review") throw new HttpError(409, "A plan can be split while it waits in Plan review");
    const latest = this.store.latestPlan(taskId);
    if (!latest) throw new HttpError(409, "This task has no plan yet");
    const { plan } = latest;
    const problem = planSubtaskProblem(plan);
    if (problem) throw new HttpError(400, problem);
    const subtasks = plan.subtasks ?? [];
    if (subtasks.length === 0) throw new HttpError(409, "The plan suggests no subtasks");
    // Closing this task would count as finishing it, and whatever waits on it would start too early.
    if (this.store.hasOpenDependants(taskId)) {
      throw new HttpError(409, "Other tasks wait for this one. Remove that wait, or approve the plan as one task, before splitting it into several.");
    }

    const made: Task[] = [];
    try {
    for (const sub of subtasks) {
      const description = [
        `Part of #${task.number}, ${task.title}, which was split into ${subtasks.length} tasks.`,
        `Goal of #${task.number}: ${plan.goal}`,
        `Steps for this task:\n${sub.steps.map((s, n) => `${n + 1}. ${plan.steps[s]}`).join("\n")}`,
        plan.context.trim() ? `Context found while planning #${task.number}:\n${plan.context.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      made.push(
        this.store.createTask({
          projectId: task.projectId,
          title: sub.title,
          description,
          kind: task.kind,
          blockedBy: sub.dependsOn.map((d) => made[d]!.id),
          autoStart: true,
        }),
      );
    }
    this.store.setAgentState(taskId, "idle");
    this.store.moveTask(taskId, { column: "done", beforeTaskId: null });
    } catch (err) {
      // All or nothing, so a retry does not leave duplicates behind.
      for (const t of made.reverse()) this.store.deleteTask(t.id);
      throw err;
    }
    this.store.addMessage({
      taskId,
      runId: null,
      role: "system",
      kind: "status",
      text: `Split into ${made.map((t) => `#${t.number} ${t.title}`).join(", ")}. This task is closed.`,
    });
    this.publish(taskId);
    this.bus.publish({ type: "tasks.changed", projectId: task.projectId });
    return made;
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
    this.mergeStep.abort(taskId);
    this.checkAborts.get(taskId)?.abort();
    this.previewAborts.get(taskId)?.abort.abort();
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

  private unsubscribeBus: (() => void) | null = null;
  private unblockPending = false;

  // Starts the research of every task that asked to start by itself and whose blockers are all done.
  startUnblocked(): void {
    for (const task of this.store.listReadyToAutoStart()) {
      // Clear the flag first, so a start that fails is not retried on every board change.
      this.store.setAutoStart(task.id, false);
      try {
        this.store.addMessage({ taskId: task.id, runId: null, role: "system", kind: "status", text: "Its blockers are done, so Dot starts the research." });
        this.startResearch(task.id);
      } catch (err) {
        this.store.addMessage({
          taskId: task.id,
          runId: null,
          role: "system",
          kind: "error",
          text: `Could not start the research by itself. Start it by hand.\n\n${err instanceof Error ? err.message : String(err)}`,
        });
        this.publish(task.id);
      }
    }
  }

  private stuckTimer: NodeJS.Timeout | null = null;

  private startStuckWatch(): void {
    const after = this.config.stuckAfterMs ?? 20 * 60_000;
    if (after <= 0) return;
    this.stuckTimer = setInterval(() => this.checkStuck(after), this.config.stuckCheckMs ?? 30_000);
    this.stuckTimer.unref();
  }

  // An agent that is mid-turn but has said nothing for a long time is hung, usually on a stalled network
  // call or a command that never ends. Stop it and flag the task. Resuming starts it again in its session.
  private checkStuck(after: number): void {
    const stuck = [...this.live.values()].filter(
      (l) => l.process && !l.stopped && l.turnsInFlight > 0 && Date.now() - l.lastActivity >= after,
    );
    for (const live of stuck) {
      this.safely(live.taskId, () => {
        const minutes = Math.max(1, Math.round((Date.now() - live.lastActivity) / 60_000));
        this.store.setNeedsInput(live.taskId, true);
        this.store.addMessage({
          taskId: live.taskId,
          runId: live.runId,
          role: "system",
          kind: "status",
          text: `Stopped: the ${stageLabel(this.store.getTask(live.taskId).kind, live.stage).toLowerCase()} sent nothing for ${minutes} ${minutes === 1 ? "minute" : "minutes"}. It may be hung on a command or a network call. Resume it or send a message to start it again.`,
        });
        this.bus.publish({ type: "messages.changed", taskId: live.taskId });
        this.stopQuietly(live.taskId);
      });
    }
  }

  // Kill every agent process. Called on server shutdown so no claude process outlives Dot.
  shutdown(): void {
    if (this.stuckTimer) clearInterval(this.stuckTimer);
    this.unsubscribeBus?.();
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
      if (task.column !== stageColumn(task.kind, run.stage)) {
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
      this.mergeStep.resume(task.id);
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
    return agentTools({ store: this.store, publish: (taskId) => this.publish(taskId) }, this.store.getRun(runId), this.getLive(runId));
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
        turnsInFlight: 0,
        lastActivity: Date.now(),
        costBase: run.costUsd,
        pending: [],
        stopped: false,
        quietStop: false,
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

  private otherAgentActive(live: Live): boolean {
    return [...this.live.values()].some(
      (l) => l !== live && l.taskId === live.taskId && !l.stopped && (l.process !== null || this.queue.includes(l.runId)),
    );
  }

  private runningCount(): number {
    let count = 0;
    for (const live of this.live.values()) if (live.process) count++;
    return count;
  }

  private dispatch(runId: number, content: ContentBlock[], expectOutcome: boolean): void {
    const live = this.getLive(runId);
    live.stopped = false;
    live.quietStop = false;
    live.expectOutcome = expectOutcome;
    if (expectOutcome) {
      live.outcome = false;
      live.nudged = false;
    }

    if (live.process?.acceptingInput) {
      live.turnsInFlight++;
      live.lastActivity = Date.now();
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
      if (live.pending.length === 0) continue;
      try {
        this.launch(live);
      } catch (err) {
        // A run that cannot start must not stay Queued, and must not hold up the runs behind it.
        const detail = err instanceof Error ? err.message : String(err);
        live.pending = [];
        this.safely(live.taskId, () => {
          this.store.updateRun(live.runId, { status: "failed", error: detail });
          this.store.setNeedsInput(live.taskId, true);
          this.store.setAgentState(live.taskId, "failed");
          this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "system", kind: "error", text: `The agent could not start.\n\n${detail}` });
          this.publish(live.taskId);
        });
      }
    }
  }

  // After waiting for a stop, the task may have moved on, such as a send-back that arrived meanwhile.
  private requireColumn(taskId: number, column: Column): void {
    if (this.store.getTask(taskId).column !== column) throw new HttpError(409, "The task changed while it was stopping. Look at it again.");
  }

  // The project's model for the stage, or the server default.
  private modelFor(project: Project, stage: AgentStage): string {
    const chosen = { research: project.researchModel, execute: project.executeModel, review: project.reviewModel }[stage];
    return chosen ?? this.config.model;
  }

  private launch(live: Live): void {
    const run = this.store.getRun(live.runId);
    const task = this.store.getTask(run.taskId);
    const project = this.store.getProject(task.projectId);
    // Outside its own column an agent is only chatting, so it gets read-only tools.
    // That keeps a past-stage agent from touching a worktree another agent is working in.
    const working = task.column === stageColumn(task.kind, run.stage);
    const readOnly: StageConfig = {
      ...stageConfig(task.kind, run.stage),
      tools: RESEARCHER_TOOLS,
      allowedTools: [...RESEARCHER_ALLOWED_TOOLS.filter((t) => !t.startsWith("mcp__")), "mcp__dot__ask_human"],
      deniedTools: RESEARCHER_DENIED_TOOLS,
    };
    // At Merge approval the executor may write the project's preview page, and nothing else, so a branch
    // that was built without one can still get a preview. Dot keeps the page out of git.
    const previewPage = run.stage === "execute" && task.column === "merge_approval" && !project.devCommand ? project.previewPath : null;
    if (previewPage && !previewPathProblem(previewPage)) {
      readOnly.tools = [...RESEARCHER_TOOLS, "Write", "Edit"];
      readOnly.allowedTools = [...readOnly.allowedTools, `Write(${previewPage})`, `Edit(${previewPage})`];
    }
    const stage: StageConfig =
      run.stage === "research"
        ? stageConfig(task.kind, "research")
        : !working
          ? readOnly
          : run.stage === "review"
            ? { ...STAGE_CONFIG.review, allowedTools: reviewerAllowedTools(project) }
            : STAGE_CONFIG[run.stage];
    // Claude Code keys sessions by working directory, so each stage must always run in the same place.
    // The executor and reviewer both work in the task's worktree.
    const cwd = run.stage === "research" ? project.repoPath : task.worktreePath;
    if (!cwd) throw new Error("This task has no worktree");
    if (run.stage !== "research" && project.previewPath && !previewPathProblem(project.previewPath)) {
      void excludeFromGit(cwd, project.previewPath).catch(() => undefined);
    }

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

    live.lastActivity = Date.now();
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
        model: this.modelFor(project, run.stage),
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
    live.turnsInFlight = 0;
    for (const content of live.pending.splice(0)) {
      live.turnsInFlight++;
      process.send(content);
    }
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
            `While the ${stageLabel(this.store.getTask(live.taskId).kind, live.stage).toLowerCase()} worked, the repository changed outside the task branch ${branch}. ` +
            `If you didn't make these changes yourself, check them and undo what you don't want:\n\n` +
            changes.map((c) => `- ${c}`).join("\n"),
        });
        this.publish(live.taskId);
      });
    })();
  }

  private onEvent(live: Live, event: StreamEvent, cwd: string): void {
    live.lastActivity = Date.now();
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
      const task = this.store.getTask(live.taskId);
      this.bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: live.taskId });
      this.enforceBudget(live, task);
      if (event.is_error === true) {
        const detail = typeof event.result === "string" && event.result ? event.result : String(event.subtype ?? "error");
        this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "system", kind: "error", text: detail });
        this.bus.publish({ type: "messages.changed", taskId: live.taskId });
      }
    }
  }

  // Pauses the task once its agents have spent the project's budget since the last pause. The pause
  // moves the checkpoint up, so resuming the task grants another budget's worth. A stage that has
  // already handed in its result is left alone, since it is about to finish anyway.
  private enforceBudget(live: Live, task: Task): void {
    // Only a turn the stage still needs an outcome from. A chat turn after the stage finished is not paused.
    if (live.stopped || live.outcome || !live.expectOutcome) return;
    const budget = this.store.getProject(task.projectId).taskBudgetUsd;
    if (budget === null) return;
    const checkpoint = this.store.budgetCheckpoint(task.id);
    if (task.costUsd - checkpoint < budget) return;

    this.store.setBudgetCheckpoint(task.id, task.costUsd);
    this.store.setNeedsInput(task.id, true);
    this.store.addMessage({
      taskId: task.id,
      runId: live.runId,
      role: "system",
      kind: "status",
      text:
        `Paused at the task budget. The agents have spent $${(task.costUsd - checkpoint).toFixed(2)} at API prices ` +
        `since the last check, and the limit is $${budget.toFixed(2)}. Resume the agent or send a message to give it another $${budget.toFixed(2)}.`,
    });
    this.bus.publish({ type: "messages.changed", taskId: task.id });
    this.stopQuietly(task.id);
  }

  // Stops the task's agents after Dot posted its own reason, so their exit adds no second "Stopped." line.
  private stopQuietly(taskId: number): void {
    for (const live of this.live.values()) if (live.taskId === taskId) live.quietStop = true;
    void this.stop(taskId);
  }

  private onTurnEnd(live: Live): void {
    live.turnsInFlight = Math.max(0, live.turnsInFlight - 1);
    // Another message is queued behind this turn. Its own turn end decides whether the stage stalled.
    if (live.turnsInFlight > 0) return;
    if (live.stopped || !live.expectOutcome || live.outcome) return;
    const run = this.store.getRun(live.runId);
    const current = this.store.getTask(live.taskId);
    if (current.column !== stageColumn(current.kind, run.stage)) return;

    if (!live.nudged) {
      live.nudged = true;
      live.turnsInFlight++;
      live.process?.send([{ type: "text", text: stageConfig(current.kind, run.stage).nudge }]);
      return;
    }
    live.expectOutcome = false;
    this.store.setNeedsInput(live.taskId, true);
    this.store.addMessage({
      taskId: live.taskId,
      runId: live.runId,
      role: "system",
      kind: "status",
      text: stageConfig(current.kind, run.stage).stalled,
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
      if (!live.quietStop) {
        this.store.addMessage({ taskId: live.taskId, runId: live.runId, role: "system", kind: "status", text: "Stopped." });
      }
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
    } else if (!this.otherAgentActive(live)) {
      // Not while another run of the task is working or queued, as after Retry from stage. This exit
      // would otherwise mark the task idle under the new agent.
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
