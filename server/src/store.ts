import type {
  AgentStage,
  AgentState,
  AttachmentRef,
  ChatData,
  ChatKind,
  ChatMessage,
  ChatRole,
  Column,
  ProjectKind,
  ProposalDecision,
  Proposals,
  ProposalsArtifact,
  ReportDoc,
  ReportDocArtifact,
  TaskKind,
  Commit,
  ExecutionArtifact,
  ExecutionReport,
  Plan,
  PlanArtifact,
  Project,
  ProjectRule,
  Review,
  RepoHost,
  ReviewArtifact,
  Run,
  RuleStatus,
  RunStatus,
  ProjectPatchSchema,
  ProjectInputSchema,
  Task,
  TaskEvent,
  TaskInputSchema,
  TaskTemplate,
  TemplateInputSchema,
  TaskMove,
  TaskPatchSchema,
} from "@dot/shared";
import { DEFAULT_KIND, kindDef, taskKindsFor } from "@dot/shared";
import type { z } from "zod";
import { transaction, type Db } from "./db.ts";
import { HttpError, notFound } from "./errors.ts";
import { searchTasks } from "./search.ts";

type ProjectData = z.output<typeof ProjectInputSchema>;
type ProjectPatchData = z.output<typeof ProjectPatchSchema>;
type TaskData = z.output<typeof TaskInputSchema>;
type TaskPatchData = z.output<typeof TaskPatchSchema>;

type Row = Record<string, string | number | null>;

const POSITION_STEP = 1024;

// Maps camelCase API fields to snake_case columns for the editable project fields.
const PROJECT_COLUMNS = {
  name: "name",
  repoPath: "repo_path",
  baseBranch: "base_branch",
  repoHost: "repo_host",
  repoOwner: "repo_owner",
  repoName: "repo_name",
  testCommand: "test_command",
  lintCommand: "lint_command",
  typecheckCommand: "typecheck_command",
  browserTesting: "browser_testing",
  devCommand: "dev_command",
  devUrl: "dev_url",
  claudeConfigDir: "claude_config_dir",
  claudeToken: "claude_token",
  taskBudgetUsd: "task_budget_usd",
  researchModel: "research_model",
  executeModel: "execute_model",
  reviewModel: "review_model",
} as const satisfies Record<keyof ProjectPatchData, string>;

const now = () => new Date().toISOString();

// Blank optional strings are stored as NULL. Booleans become 0/1 for SQLite.
function toSql(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number") return value;
  throw new Error(`Unsupported value: ${String(value)}`);
}

function toProject(row: Row): Project {
  return {
    id: row.id as number,
    name: row.name as string,
    kind: row.kind as ProjectKind,
    repoPath: row.repo_path as string,
    baseBranch: row.base_branch as string,
    repoHost: row.repo_host as RepoHost | null,
    repoOwner: row.repo_owner as string | null,
    repoName: row.repo_name as string | null,
    testCommand: row.test_command as string | null,
    lintCommand: row.lint_command as string | null,
    typecheckCommand: row.typecheck_command as string | null,
    browserTesting: row.browser_testing === 1,
    devCommand: row.dev_command as string | null,
    devUrl: row.dev_url as string | null,
    claudeConfigDir: row.claude_config_dir as string | null,
    claudeToken: row.claude_token as string | null,
    taskBudgetUsd: row.task_budget_usd as number | null,
    researchModel: row.research_model as string | null,
    executeModel: row.execute_model as string | null,
    reviewModel: row.review_model as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// Open blockers ride along as "id:number" pairs, so one query serves the whole board.
const TASK_SELECT = `SELECT tasks.*, (
    SELECT group_concat(b.id || ':' || b.number)
    FROM task_dependencies d JOIN tasks b ON b.id = d.blocked_by_id
    WHERE d.task_id = tasks.id AND b.column_key != 'done'
  ) AS blocked_by, (
    SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r WHERE r.task_id = tasks.id
  ) AS cost_usd FROM tasks`;

function parseBlockers(value: unknown): Task["blockedBy"] {
  if (typeof value !== "string" || value === "") return [];
  return value.split(",").map((pair) => {
    const [id, number] = pair.split(":").map(Number);
    return { id: id!, number: number! };
  });
}

function toTask(row: Row): Task {
  return {
    id: row.id as number,
    projectId: row.project_id as number,
    number: row.number as number,
    title: row.title as string,
    description: row.description as string,
    kind: row.kind as TaskKind,
    column: row.column_key as Column,
    position: row.position as number,
    needsInput: row.needs_input === 1,
    agentState: row.agent_state as AgentState,
    branch: row.branch as string | null,
    worktreePath: row.worktree_path as string | null,
    prId: row.pr_id as number | null,
    prUrl: row.pr_url as string | null,
    reviewRound: row.review_round as number,
    costUsd: (row.cost_usd as number | undefined) ?? 0,
    blockedBy: parseBlockers(row.blocked_by),
    autoStart: row.auto_start === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toTemplate(row: Row): TaskTemplate {
  return {
    id: row.id as number,
    projectId: row.project_id as number,
    name: row.name as string,
    title: row.title as string,
    description: row.description as string,
  };
}

function toRun(row: Row): Run {
  return {
    id: row.id as number,
    taskId: row.task_id as number,
    stage: row.stage as AgentStage,
    sessionId: row.session_id as string,
    sessionStarted: row.session_started === 1,
    claudeConfigDir: row.claude_config_dir as string | null,
    claudeToken: row.claude_token as string | null,
    status: row.status as RunStatus,
    costUsd: row.cost_usd as number,
    error: row.error as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toRule(row: Row): ProjectRule {
  return {
    id: row.id as number,
    projectId: row.project_id as number,
    text: row.text as string,
    status: row.status as RuleStatus,
    sourceTaskId: (row.source_task_id as number | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function toMessage(row: Row): ChatMessage {
  return {
    id: row.id as number,
    taskId: row.task_id as number,
    runId: row.run_id as number | null,
    stage: (row.stage as AgentStage | null) ?? null,
    role: row.role as ChatRole,
    kind: row.kind as ChatKind,
    text: row.text as string,
    data: row.data ? (JSON.parse(row.data as string) as ChatData) : null,
    createdAt: row.created_at as string,
  };
}

export type Attachment = AttachmentRef & { taskId: number; size: number; path: string };

export class Store {
  constructor(private readonly db: Db) {}

  search(query: string, options: { projectId?: number; limit?: number } = {}) {
    return searchTasks(this.db, query, options);
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() as Row[];
    return rows.map(toProject);
  }

  getProject(id: number): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("Project");
    return toProject(row);
  }

  createProject(data: ProjectData): Project {
    const keys = Object.keys(PROJECT_COLUMNS) as (keyof typeof PROJECT_COLUMNS)[];
    const columns = [...keys.map((k) => PROJECT_COLUMNS[k]), "kind", "created_at", "updated_at"];
    const stamp = now();
    const values = [...keys.map((k) => toSql(data[k])), data.kind ?? "repo", stamp, stamp];
    const result = this.db
      .prepare(`INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...values);
    return this.getProject(Number(result.lastInsertRowid));
  }

  updateProject(id: number, patch: ProjectPatchData): Project {
    this.getProject(id);
    const keys = (Object.keys(patch) as (keyof typeof PROJECT_COLUMNS)[]).filter(
      (k) => k in PROJECT_COLUMNS && patch[k] !== undefined,
    );
    if (keys.length > 0) {
      const sets = [...keys.map((k) => `${PROJECT_COLUMNS[k]} = ?`), "updated_at = ?"];
      this.db
        .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
        .run(...keys.map((k) => toSql(patch[k])), now(), id);
    }
    return this.getProject(id);
  }

  deleteProject(id: number): void {
    this.getProject(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  listTasks(projectId: number): Task[] {
    this.getProject(projectId);
    const rows = this.db
      .prepare(`${TASK_SELECT} WHERE project_id = ? ORDER BY column_key, position`)
      .all(projectId) as Row[];
    return rows.map(toTask);
  }

  // Inbox tasks that asked to start by themselves and have no open blocker left.
  listReadyToAutoStart(): Task[] {
    const rows = this.db
      .prepare(`${TASK_SELECT} WHERE column_key = 'inbox' AND auto_start = 1 AND agent_state = 'idle'`)
      .all() as Row[];
    return rows.map(toTask).filter((t) => t.blockedBy.length === 0);
  }

  setAutoStart(id: number, on: boolean): void {
    this.db.prepare("UPDATE tasks SET auto_start = ? WHERE id = ?").run(on ? 1 : 0, id);
  }

  getTask(id: number): Task {
    const row = this.db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw notFound("Task");
    return toTask(row);
  }

  createTask(data: TaskData): Task {
    const project = this.getProject(data.projectId);
    const kind = data.kind ?? DEFAULT_KIND;
    if (!taskKindsFor(project.kind).includes(kind)) {
      throw new HttpError(400, `A ${project.kind} project cannot hold ${kindDef(kind).label.toLowerCase()} tasks`);
    }
    const last = this.db
      .prepare("SELECT MAX(position) AS max FROM tasks WHERE project_id = ? AND column_key = 'inbox'")
      .get(data.projectId) as { max: number | null };
    const stamp = now();
    const id = transaction(this.db, () => {
      const counter = this.db
        .prepare("SELECT next_task_number AS n FROM projects WHERE id = ?")
        .get(data.projectId) as { n: number };
      this.db.prepare("UPDATE projects SET next_task_number = ? WHERE id = ?").run(counter.n + 1, data.projectId);
      const result = this.db
        .prepare(
          `INSERT INTO tasks (project_id, number, title, description, kind, column_key, position, auto_start, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)`,
        )
        .run(data.projectId, counter.n, data.title, data.description, kind, (last.max ?? 0) + POSITION_STEP, data.autoStart ? 1 : 0, stamp, stamp);
      const newId = Number(result.lastInsertRowid);
      this.setBlockers(newId, data.projectId, data.blockedBy);
      return newId;
    });
    return this.getTask(id);
  }

  // Replaces the task's blockers. They must be other tasks of the same project, and must not loop back.
  private setBlockers(taskId: number, projectId: number, blockerIds: number[]): void {
    const unique = [...new Set(blockerIds)];
    const find = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?");
    for (const id of unique) {
      if (id === taskId) throw new HttpError(400, "A task cannot block itself");
      const row = find.get(id) as { project_id: number } | undefined;
      if (!row || row.project_id !== projectId) throw new HttpError(400, "A blocker must be a task in the same project");
    }
    // Adding taskId -> blocker closes a loop when taskId can already be reached from the blocker.
    const next = this.db.prepare("SELECT blocked_by_id AS id FROM task_dependencies WHERE task_id = ?");
    for (const start of unique) {
      const seen = new Set<number>();
      const stack = [start];
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (at === taskId) throw new HttpError(400, "Those blockers would make the tasks wait on each other");
        if (seen.has(at)) continue;
        seen.add(at);
        for (const row of next.all(at) as { id: number }[]) stack.push(row.id);
      }
    }
    this.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const insert = this.db.prepare("INSERT INTO task_dependencies (task_id, blocked_by_id) VALUES (?, ?)");
    for (const id of unique) insert.run(taskId, id);
  }

  updateTask(id: number, patch: TaskPatchData): Task {
    const task = this.getTask(id);
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE tasks SET title = ?, description = ?, auto_start = ?, updated_at = ? WHERE id = ?")
        .run(patch.title ?? task.title, patch.description ?? task.description, (patch.autoStart ?? task.autoStart) ? 1 : 0, now(), id);
      if (patch.blockedBy) this.setBlockers(id, task.projectId, patch.blockedBy);
    });
    return this.getTask(id);
  }

  // Columns hold a handful of cards, so a move renumbers the whole target column.
  // That keeps positions evenly spaced without any rebalancing logic.
  moveTask(id: number, move: TaskMove): Task {
    const task = this.getTask(id);
    if (move.beforeTaskId === id) return task;

    return transaction(this.db, () => {
      const siblings = (
        this.db
          .prepare("SELECT id FROM tasks WHERE project_id = ? AND column_key = ? AND id != ? ORDER BY position")
          .all(task.projectId, move.column, id) as { id: number }[]
      ).map((r) => r.id);

      let index = siblings.length;
      if (move.beforeTaskId !== null) {
        index = siblings.indexOf(move.beforeTaskId);
        if (index === -1) throw new HttpError(400, "beforeTaskId is not in the target column");
      }
      siblings.splice(index, 0, id);

      const setPosition = this.db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
      siblings.forEach((taskId, i) => setPosition.run((i + 1) * POSITION_STEP, taskId));
      this.db.prepare("UPDATE tasks SET column_key = ?, updated_at = ? WHERE id = ?").run(move.column, now(), id);
      if (task.column !== move.column) this.logEvent(id, "moved", move.column);
      return this.getTask(id);
    });
  }

  deleteTask(id: number): Task {
    const task = this.getTask(id);
    // Deleting a blocker frees the tasks waiting on it. Those must not start by themselves, since the
    // blocker never finished.
    this.db
      .prepare("UPDATE tasks SET auto_start = 0 WHERE id IN (SELECT task_id FROM task_dependencies WHERE blocked_by_id = ?)")
      .run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return task;
  }

  private logEvent(taskId: number, kind: TaskEvent["kind"], detail = ""): void {
    this.db
      .prepare("INSERT INTO task_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, kind, detail, now());
  }

  listEvents(taskId: number): TaskEvent[] {
    const rows = this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(taskId) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      taskId: r.task_id as number,
      kind: r.kind as TaskEvent["kind"],
      detail: r.detail as string,
      createdAt: r.created_at as string,
    }));
  }

  setAgentState(taskId: number, state: AgentState): Task {
    if (state === "failed" && this.getTask(taskId).agentState !== "failed") this.logEvent(taskId, "failed");
    this.db.prepare("UPDATE tasks SET agent_state = ?, updated_at = ? WHERE id = ?").run(state, now(), taskId);
    return this.getTask(taskId);
  }

  setNeedsInput(taskId: number, needsInput: boolean): Task {
    if (needsInput && !this.getTask(taskId).needsInput) this.logEvent(taskId, "needs_you");
    this.db
      .prepare("UPDATE tasks SET needs_input = ?, updated_at = ? WHERE id = ?")
      .run(needsInput ? 1 : 0, now(), taskId);
    return this.getTask(taskId);
  }

  // The task cost at its last budget pause. The budget counts what was spent after this.
  budgetCheckpoint(taskId: number): number {
    const row = this.db.prepare("SELECT budget_checkpoint_usd AS usd FROM tasks WHERE id = ?").get(taskId) as
      | { usd: number }
      | undefined;
    return row?.usd ?? 0;
  }

  setBudgetCheckpoint(taskId: number, usd: number): void {
    this.db.prepare("UPDATE tasks SET budget_checkpoint_usd = ? WHERE id = ?").run(usd, taskId);
  }

  // Runs

  createRun(taskId: number, stage: AgentStage, sessionId: string): Run {
    const stamp = now();
    const result = this.db
      .prepare("INSERT INTO runs (task_id, stage, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, stage, sessionId, stamp, stamp);
    return this.getRun(Number(result.lastInsertRowid));
  }

  getRun(id: number): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("Run");
    return toRun(row);
  }

  latestRun(taskId: number, stage: AgentStage): Run | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? AND stage = ? ORDER BY id DESC LIMIT 1")
      .get(taskId, stage) as Row | undefined;
    return row ? toRun(row) : null;
  }

  listRuns(taskId: number): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(toRun);
  }

  listRunsByStatus(statuses: RunStatus[]): Run[] {
    const marks = statuses.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM runs WHERE status IN (${marks})`).all(...statuses) as Row[]).map(toRun);
  }

  // Recorded at each fresh launch, before the CLI creates the session, so it always names the
  // folder the session ends up in.
  setRunAccount(id: number, dir: string | null, token: string | null): void {
    this.db.prepare("UPDATE runs SET claude_config_dir = ?, claude_token = ? WHERE id = ?").run(dir, token, id);
  }

  markSessionStarted(id: number): void {
    this.db.prepare("UPDATE runs SET session_started = 1 WHERE id = ? AND session_started = 0").run(id);
  }

  updateRun(id: number, patch: { status?: RunStatus; costUsd?: number; error?: string | null }): Run {
    const run = this.getRun(id);
    this.db
      .prepare("UPDATE runs SET status = ?, cost_usd = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.status ?? run.status,
        patch.costUsd ?? run.costUsd,
        patch.error === undefined ? run.error : patch.error,
        now(),
        id,
      );
    return this.getRun(id);
  }

  // Chat messages. The stage comes from the run, so system messages without a run have none.

  addMessage(message: {
    taskId: number;
    runId: number | null;
    role: ChatRole;
    kind: ChatKind;
    text: string;
    data?: ChatData | null;
  }): ChatMessage {
    const result = this.db
      .prepare("INSERT INTO messages (task_id, run_id, role, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        message.taskId,
        message.runId,
        message.role,
        message.kind,
        message.text,
        message.data ? JSON.stringify(message.data) : null,
        now(),
      );
    const row = this.db
      .prepare("SELECT m.*, r.stage FROM messages m LEFT JOIN runs r ON r.id = m.run_id WHERE m.id = ?")
      .get(Number(result.lastInsertRowid)) as Row;
    return toMessage(row);
  }

  // afterId lets the chat fetch only messages it hasn't seen yet.
  listMessages(taskId: number, afterId = 0): ChatMessage[] {
    const rows = this.db
      .prepare(
        "SELECT m.*, r.stage FROM messages m LEFT JOIN runs r ON r.id = m.run_id WHERE m.task_id = ? AND m.id > ? ORDER BY m.id",
      )
      .all(taskId, afterId) as Row[];
    return rows.map(toMessage);
  }

  // The newest question nobody has answered yet, or null. Pauses and failures raise Needs input without a question.
  latestOpenQuestion(taskId: number): ChatMessage | null {
    const row = this.db
      .prepare(
        `SELECT m.*, r.stage FROM messages m LEFT JOIN runs r ON r.id = m.run_id
         WHERE m.task_id = ? AND m.kind = 'question' AND (m.data IS NULL OR json_extract(m.data, '$.answered') IS NOT 1)
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  // Once the user replies to a run, its open questions no longer need quick-reply buttons.
  markQuestionsAnswered(runId: number): void {
    const rows = this.db
      .prepare("SELECT id, data FROM messages WHERE run_id = ? AND kind = 'question'")
      .all(runId) as { id: number; data: string | null }[];
    const update = this.db.prepare("UPDATE messages SET data = ? WHERE id = ?");
    for (const row of rows) {
      const data = row.data ? (JSON.parse(row.data) as ChatData) : {};
      if (!data.answered) update.run(JSON.stringify({ ...data, answered: true }), row.id);
    }
  }

  setPullRequest(taskId: number, prId: number | null, prUrl: string | null): Task {
    this.db
      .prepare("UPDATE tasks SET pr_id = ?, pr_url = ?, updated_at = ? WHERE id = ?")
      .run(prId, prUrl, now(), taskId);
    return this.getTask(taskId);
  }

  setTaskWorkspace(taskId: number, branch: string, worktreePath: string | null): Task {
    this.db
      .prepare("UPDATE tasks SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?")
      .run(branch, worktreePath, now(), taskId);
    return this.getTask(taskId);
  }

  // Artifacts are versioned per task and type. Every save, by agent or user, adds a version.

  private addArtifact(taskId: number, runId: number | null, type: string, author: "agent" | "user", payload: unknown) {
    const last = this.db
      .prepare("SELECT MAX(version) AS max FROM artifacts WHERE task_id = ? AND type = ?")
      .get(taskId, type) as { max: number | null };
    this.db
      .prepare(
        "INSERT INTO artifacts (task_id, run_id, type, version, author, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(taskId, runId, type, (last.max ?? 0) + 1, author, JSON.stringify(payload), now());
  }

  private latestArtifact(taskId: number, type: string) {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? AND type = ? ORDER BY version DESC LIMIT 1")
      .get(taskId, type) as Row | undefined;
    if (!row) return null;
    return {
      version: row.version as number,
      author: row.author as "agent" | "user",
      payload: JSON.parse(row.payload as string) as unknown,
      createdAt: row.created_at as string,
    };
  }

  addPlan(taskId: number, runId: number | null, author: "agent" | "user", plan: Plan): PlanArtifact {
    this.addArtifact(taskId, runId, "plan", author, plan);
    return this.latestPlan(taskId)!;
  }

  latestPlan(taskId: number): PlanArtifact | null {
    const a = this.latestArtifact(taskId, "plan");
    return a && { version: a.version, author: a.author, plan: a.payload as Plan, createdAt: a.createdAt };
  }

  addReportDoc(taskId: number, runId: number | null, author: "agent" | "user", report: ReportDoc): ReportDocArtifact {
    this.addArtifact(taskId, runId, "document", author, report);
    return this.latestReportDoc(taskId)!;
  }

  latestReportDoc(taskId: number): ReportDocArtifact | null {
    const a = this.latestArtifact(taskId, "document");
    return a && { version: a.version, author: a.author, report: a.payload as ReportDoc, createdAt: a.createdAt };
  }

  // Triage output. The agent's items are one artifact per version. Your decisions for a version are
  // saved apart from it, as a newer row each time, so the agent's own words never change.
  addProposals(taskId: number, runId: number | null, proposals: Proposals): ProposalsArtifact {
    this.addArtifact(taskId, runId, "proposals", "agent", proposals);
    return this.latestProposals(taskId)!;
  }

  latestProposals(taskId: number): ProposalsArtifact | null {
    const a = this.latestArtifact(taskId, "proposals");
    if (!a) return null;
    const row = this.db
      .prepare("SELECT payload FROM artifacts WHERE task_id = ? AND type = 'proposal_decisions' ORDER BY version DESC LIMIT 1")
      .get(taskId) as { payload: string } | undefined;
    const saved = row ? (JSON.parse(row.payload) as { forVersion: number; decisions: Record<number, ProposalDecision> }) : null;
    return {
      version: a.version,
      proposals: a.payload as Proposals,
      decisions: saved && saved.forVersion === a.version ? saved.decisions : {},
      createdAt: a.createdAt,
    };
  }

  // Adds decisions for one version of the proposals to the ones already saved.
  addProposalDecisions(taskId: number, forVersion: number, decided: Record<number, ProposalDecision>): void {
    const current = this.latestProposals(taskId);
    const merged = current && current.version === forVersion ? { ...current.decisions, ...decided } : decided;
    this.addArtifact(taskId, null, "proposal_decisions", "user", { forVersion, decisions: merged });
  }

  addReview(taskId: number, runId: number, round: number, reportVersion: number, review: Review): ReviewArtifact {
    this.addArtifact(taskId, runId, "review", "agent", { round, reportVersion, review });
    return this.latestReview(taskId)!;
  }

  latestReview(taskId: number): ReviewArtifact | null {
    const a = this.latestArtifact(taskId, "review");
    if (!a) return null;
    // Reviews saved before reportVersion existed used the report version as the round.
    const { round, reportVersion, review } = a.payload as { round: number; reportVersion?: number; review: Review };
    return { version: a.version, round, reportVersion: reportVersion ?? round, author: a.author, review, createdAt: a.createdAt };
  }

  // Every branch Dot has given a task in this project.
  listTaskBranches(projectId: number): string[] {
    const rows = this.db
      .prepare("SELECT branch FROM tasks WHERE project_id = ? AND branch IS NOT NULL")
      .all(projectId) as { branch: string }[];
    return rows.map((r) => r.branch);
  }

  listTasksInColumns(columns: Column[]): Task[] {
    const marks = columns.map(() => "?").join(", ");
    const rows = this.db.prepare(`${TASK_SELECT} WHERE column_key IN (${marks})`).all(...columns) as Row[];
    return rows.map(toTask);
  }

  setReviewRound(taskId: number, round: number): Task {
    this.db.prepare("UPDATE tasks SET review_round = ?, updated_at = ? WHERE id = ?").run(round, now(), taskId);
    return this.getTask(taskId);
  }

  addExecutionReport(taskId: number, runId: number, report: ExecutionReport, commits: Commit[]): ExecutionArtifact {
    this.addArtifact(taskId, runId, "execution_report", "agent", { report, commits });
    return this.latestExecutionReport(taskId)!;
  }

  listExecutionReports(taskId: number): ExecutionArtifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? AND type = 'execution_report' ORDER BY version")
      .all(taskId) as Row[];
    return rows.map((row) => {
      const { report, commits } = JSON.parse(row.payload as string) as { report: ExecutionReport; commits: Commit[] };
      return { version: row.version as number, report, commits, createdAt: row.created_at as string };
    });
  }

  latestExecutionReport(taskId: number): ExecutionArtifact | null {
    const a = this.latestArtifact(taskId, "execution_report");
    if (!a) return null;
    const { report, commits } = a.payload as { report: ExecutionReport; commits: Commit[] };
    return { version: a.version, report, commits, createdAt: a.createdAt };
  }

  // Attachments

  addAttachment(a: {
    taskId: number;
    fileName: string;
    mediaType: string;
    size: number;
    path: string;
    origin?: "chat" | "task";
  }): Attachment {
    const result = this.db
      .prepare(
        "INSERT INTO attachments (task_id, file_name, media_type, size, path, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(a.taskId, a.fileName, a.mediaType, a.size, a.path, a.origin ?? "chat", now());
    return this.getAttachment(Number(result.lastInsertRowid));
  }

  // Images attached when the task was created. The researcher gets them with its brief.
  taskAttachments(taskId: number): Attachment[] {
    const ids = this.db
      .prepare("SELECT id FROM attachments WHERE task_id = ? AND origin = 'task' ORDER BY id")
      .all(taskId) as { id: number }[];
    return ids.map((r) => this.getAttachment(r.id));
  }

  // Removes an image added with the task. Chat images stay, since messages point at them.
  removeTaskAttachment(id: number): string {
    const attachment = this.getAttachment(id);
    const row = this.db.prepare("SELECT origin FROM attachments WHERE id = ?").get(id) as { origin: string };
    if (row.origin !== "task") throw new HttpError(400, "Only images attached to the task can be removed");
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment.path;
  }

  // Project rules

  listRules(projectId: number): ProjectRule[] {
    this.getProject(projectId);
    const rows = this.db
      .prepare("SELECT * FROM project_rules WHERE project_id = ? AND status <> 'dismissed' ORDER BY id")
      .all(projectId) as Row[];
    return rows.map(toRule);
  }

  // What the agents are told. Only rules the user accepted.
  activeRules(projectId: number): string[] {
    const rows = this.db
      .prepare("SELECT text FROM project_rules WHERE project_id = ? AND status = 'active' ORDER BY id")
      .all(projectId) as { text: string }[];
    return rows.map((r) => r.text);
  }

  addRule(projectId: number, text: string, status: RuleStatus, sourceTaskId: number | null = null): ProjectRule | null {
    this.getProject(projectId);
    // The same rule is not added twice, whatever its status.
    const key = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const existing = this.db
      .prepare("SELECT id, text, status FROM project_rules WHERE project_id = ?")
      .all(projectId) as { id: number; text: string; status: RuleStatus }[];
    const same = existing.find((r) => key(r.text) === key(text));
    if (same) {
      // A rule you write yourself brings back one you removed, or accepts the reviewer's suggestion of it.
      // The reviewer's own suggestions never do, so a dismissed rule stays hidden from it.
      if (status === "active" && same.status !== "active") return this.updateRule(same.id, { status: "active" });
      return null;
    }
    const result = this.db
      .prepare("INSERT INTO project_rules (project_id, text, status, source_task_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, text, status, sourceTaskId, now());
    return toRule(this.db.prepare("SELECT * FROM project_rules WHERE id = ?").get(Number(result.lastInsertRowid)) as Row);
  }

  suggestRules(projectId: number, taskId: number, texts: string[]): ProjectRule[] {
    return texts.flatMap((text) => this.addRule(projectId, text, "suggested", taskId) ?? []);
  }

  updateRule(id: number, patch: { status?: RuleStatus; text?: string }): ProjectRule {
    const row = this.db.prepare("SELECT * FROM project_rules WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("Rule");
    this.db
      .prepare("UPDATE project_rules SET status = ?, text = ? WHERE id = ?")
      .run(patch.status ?? (row.status as string), patch.text ?? (row.text as string), id);
    return toRule(this.db.prepare("SELECT * FROM project_rules WHERE id = ?").get(id) as Row);
  }

  deleteRule(id: number): void {
    // Dismissed, not deleted, so the reviewer's next suggestion of the same rule stays hidden.
    const result = this.db.prepare("UPDATE project_rules SET status = 'dismissed' WHERE id = ?").run(id);
    if (result.changes === 0) throw notFound("Rule");
  }

  // Templates

  listTemplates(projectId: number): TaskTemplate[] {
    this.getProject(projectId);
    const rows = this.db.prepare("SELECT * FROM task_templates WHERE project_id = ? ORDER BY name").all(projectId) as Row[];
    return rows.map(toTemplate);
  }

  addTemplate(projectId: number, input: z.output<typeof TemplateInputSchema>): TaskTemplate {
    this.getProject(projectId);
    const result = this.db
      .prepare("INSERT INTO task_templates (project_id, name, title, description, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, input.name, input.title, input.description, now());
    return toTemplate(
      this.db.prepare("SELECT * FROM task_templates WHERE id = ?").get(Number(result.lastInsertRowid)) as Row,
    );
  }

  deleteTemplate(id: number): void {
    const result = this.db.prepare("DELETE FROM task_templates WHERE id = ?").run(id);
    if (result.changes === 0) throw notFound("Template");
  }

  getAttachment(id: number): Attachment {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("Attachment");
    return {
      id: row.id as number,
      taskId: row.task_id as number,
      fileName: row.file_name as string,
      mediaType: row.media_type as string,
      size: row.size as number,
      path: row.path as string,
    };
  }
}
