import { z } from "zod";
import { DEFAULT_KIND, kindDef, PROPOSABLE_KINDS, TASK_KINDS } from "./kinds.ts";

export * from "./kinds.ts";

// Board columns, in order. Agents will move cards through these in later steps.
export const COLUMNS = [
  "inbox",
  "research",
  "plan_review",
  "report_review",
  "triage_review",
  "execute",
  "review",
  "merge_approval",
  "merge",
  "done",
] as const;

export const ColumnSchema = z.enum(COLUMNS);
export type Column = z.infer<typeof ColumnSchema>;

export const COLUMN_LABELS: Record<Column, string> = {
  inbox: "Inbox",
  research: "Research",
  plan_review: "Plan review",
  report_review: "Report review",
  triage_review: "Triage review",
  execute: "Execute",
  review: "Review",
  merge_approval: "Merge approval",
  merge: "Merge",
  done: "Done",
};

const optionalText = z.string().trim().max(1000).nullable().optional();

// Where the repository's pull requests live. Dot reads it from the origin remote unless a project sets it.
export const REPO_HOSTS = ["bitbucket", "github"] as const;
export const RepoHostSchema = z.enum(REPO_HOSTS);
export type RepoHost = z.infer<typeof RepoHostSchema>;
export const REPO_HOST_LABELS: Record<RepoHost, string> = { bitbucket: "Bitbucket", github: "GitHub" };

// What Dot read from a repository's origin remote, for the project settings.
export const RemoteQuerySchema = z.object({ repoPath: z.string().trim().min(1) });
export type RemoteInfo = {
  url: string | null;
  host: RepoHost | null;
  owner: string | null;
  name: string | null;
};

// A project is a git repository, or a workspace with no repository. A workspace holds tasks that do not
// change code, such as reports. Dot gives it a scratch folder for its agents to work in.
export const PROJECT_KINDS = ["repo", "workspace"] as const;
export const ProjectKindSchema = z.enum(PROJECT_KINDS);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

// Aliases the model picker offers. A project may also hold a full model name set through the API.
export const MODEL_CHOICES = ["opus", "sonnet", "haiku"] as const;
const modelName = z
  .string()
  .trim()
  .max(100)
  .regex(/^[\w.\-[\]]*$/, "Use letters, digits, dots, dashes and brackets")
  .nullable()
  .optional();

// Fields shared by create and patch. Defaults live only on the create schema,
// so a patch never resets a field the client left out.
const projectFields = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  repoPath: z.string().trim().min(1, "Repo path is required"),
  baseBranch: z.string().trim().min(1).max(200),
  // Blank fields fall back to what Dot reads from the origin remote.
  repoHost: RepoHostSchema.nullable().optional(),
  repoOwner: optionalText,
  repoName: optionalText,
  testCommand: optionalText,
  lintCommand: optionalText,
  typecheckCommand: optionalText,
  browserTesting: z.boolean(),
  devCommand: optionalText,
  devUrl: optionalText,
  // A CLAUDE_CONFIG_DIR for this project's agents, to use a different Claude login. Null uses the default.
  claudeConfigDir: optionalText,
  // The name of a token the server holds as DOT_CLAUDE_TOKEN_<NAME>. Null uses the default login.
  claudeToken: optionalText,
  // Agents on a task pause and flag Needs input after this much API-price spend. Null means no limit.
  taskBudgetUsd: z.number().positive("Use a number above 0, or leave it blank").max(100000).nullable().optional(),
  // The model each stage runs on: an alias such as "sonnet" or a full model name. Null uses the server default.
  researchModel: modelName,
  executeModel: modelName,
  reviewModel: modelName,
});

// A hosted repository as "owner/name" (a Bitbucket workspace and repo slug work the same way).
export const CloneRepoSchema = z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, "Use the form owner/name");

// A new project points at a folder (repoPath) or names a repository for Dot to clone (cloneRepo),
// on the host in repoHost (GitHub when left out).
export const ProjectInputSchema = projectFields
  .extend({
    kind: ProjectKindSchema.default("repo"),
    repoPath: projectFields.shape.repoPath.optional(),
    cloneRepo: CloneRepoSchema.optional(),
    baseBranch: projectFields.shape.baseBranch.default("main"),
    browserTesting: z.boolean().default(false),
  })
  .refine((p) => (p.kind === "workspace" ? !p.repoPath && !p.cloneRepo : Boolean(p.repoPath) !== Boolean(p.cloneRepo)), {
    message: "Give either a repo path or a repository to clone. A workspace has neither.",
    path: ["repoPath"],
  });
export type ProjectInput = z.input<typeof ProjectInputSchema>;

export const ProjectPatchSchema = projectFields.partial();
export type ProjectPatch = z.input<typeof ProjectPatchSchema>;

export const ProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: ProjectKindSchema,
  // For a workspace, the scratch folder Dot made for it.
  repoPath: z.string(),
  baseBranch: z.string(),
  repoHost: RepoHostSchema.nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  testCommand: z.string().nullable(),
  lintCommand: z.string().nullable(),
  typecheckCommand: z.string().nullable(),
  browserTesting: z.boolean(),
  devCommand: z.string().nullable(),
  devUrl: z.string().nullable(),
  claudeConfigDir: z.string().nullable(),
  claudeToken: z.string().nullable(),
  taskBudgetUsd: z.number().nullable(),
  researchModel: z.string().nullable(),
  executeModel: z.string().nullable(),
  reviewModel: z.string().nullable(),
  // True when the folder is a clone Dot made in its own repos folder, so deleting the project can remove it.
  cloned: z.boolean().optional(),
  // Set when the base branch asked for did not exist in the clone and Dot used the repo's default instead.
  baseBranchNote: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// Which Claude login a config folder holds, from `claude auth status`.
export const ClaudeAccountQuerySchema = z.object({ configDir: optionalText, token: optionalText });
// Named tokens the server holds, for the project settings. `hasDefault` says DOT_CLAUDE_TOKEN is set.
export type ClaudeTokens = { names: string[]; hasDefault: boolean };
export type ClaudeAccount = {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  configDirectory: string | null;
};

// How much of each subscription limit is used, from Anthropic's usage endpoint. `percent` is 0 to 100.
export type UsageLimit = {
  id: string;
  label: string;
  group: "session" | "weekly";
  percent: number;
  severity: "normal" | "warning" | "critical";
  resetsAt: string | null;
};
// Pay-as-you-go credits that cover you after a plan limit. Amounts are in minor units, such as cents.
export type UsageSpend = {
  usedMinor: number;
  limitMinor: number | null;
  currency: string;
  exponent: number;
  percent: number;
  severity: "normal" | "warning" | "critical";
};
export type ClaudeUsage = { limits: UsageLimit[]; spend: UsageSpend | null; fetchedAt: string };

// Stages that have an agent. Grows as the executor, reviewer and merge steps land.
export const AGENT_STAGES = ["research", "execute", "review"] as const;
export const AgentStageSchema = z.enum(AGENT_STAGES);
export type AgentStage = z.infer<typeof AgentStageSchema>;

export const STAGE_LABELS: Record<AgentStage, string> = {
  research: "Researcher",
  execute: "Executor",
  review: "Reviewer",
};

// What to call a stage's agent on a task of this kind.
export const stageLabel = (kind: string, stage: AgentStage): string => kindDef(kind).stageLabels[stage] ?? STAGE_LABELS[stage];

// After this many review rounds that request changes, the task waits for you instead of looping.
export const MAX_REVIEW_ROUNDS = 3;

// What the task's agent is doing right now, for the card badge.
export const AgentStateSchema = z.enum(["idle", "queued", "running", "waiting", "failed"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const TaskSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  // The card number shown in the UI. Counts up within the project, unlike id.
  number: z.number().int(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(TASK_KINDS),
  column: ColumnSchema,
  position: z.number(),
  needsInput: z.boolean(),
  agentState: AgentStateSchema,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  prId: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  reviewRound: z.number().int(),
  // What all the task's agent runs would cost at API prices. Subscriptions cover it, so it is a size guide.
  costUsd: z.number(),
  // Tasks that must be done before this one can start. Finished blockers drop off the list.
  blockedBy: z.array(z.object({ id: z.number().int(), number: z.number().int() })),
  // Start the research by itself once every blocker is done.
  autoStart: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

// The board shows four lanes. Each groups the pipeline columns that mean the same thing to the person watching.
export const LANES = ["inbox", "working", "needs_you", "done"] as const;
export type Lane = (typeof LANES)[number];

// A task waits for you at its kind's gate columns (plan review and merge approval for code),
// or whenever its agent has a question or failed.
export function laneOf(task: Pick<Task, "kind" | "column" | "needsInput" | "agentState">): Lane {
  if (task.column === "inbox") return "inbox";
  if (task.column === "done") return "done";
  if (kindDef(task.kind).gates.includes(task.column)) return "needs_you";
  if (task.needsInput || task.agentState === "failed") return "needs_you";
  return "working";
}

// What Dot keeps on disk. A worktree is removable once its task is done. Orphans are folders no task owns.
export type StorageReport = {
  worktrees: {
    taskId: number;
    number: number;
    title: string;
    projectName: string;
    column: Column;
    bytes: number;
    removable: boolean;
  }[];
  orphans: { name: string; bytes: number }[];
  other: { label: string; bytes: number }[];
};

// One task that matches a search. `snippet` holds the matching text, with \u0001 before and \u0002 after each matched word.
export type SearchHit = {
  taskId: number;
  projectId: number;
  projectName: string;
  number: number;
  title: string;
  column: Column;
  // Where the match was found.
  kind: "task" | "message" | "plan" | "report" | "review" | "document";
  snippet: string;
};

// One row of the All projects view. `waiting` lists the first few tasks that need you.
export type ProjectOverview = {
  projectId: number;
  lanes: Record<Lane, number>;
  running: number;
  waiting: { id: number; number: number; title: string }[];
};

export const TaskInputSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().max(20000).default(""),
  kind: z.enum(TASK_KINDS).default(DEFAULT_KIND),
  blockedBy: z.array(z.number().int().positive()).max(20).default([]),
  autoStart: z.boolean().optional(),
});
export type TaskInput = z.input<typeof TaskInputSchema>;

export const TaskPatchSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200).optional(),
  description: z.string().max(20000).optional(),
  blockedBy: z.array(z.number().int().positive()).max(20).optional(),
  autoStart: z.boolean().optional(),
});
export type TaskPatch = z.input<typeof TaskPatchSchema>;

// Many tasks at once, from a pasted list. Each title becomes a task with no description.
export const MAX_BATCH = 50;
export const TaskBatchSchema = z.object({
  projectId: z.number().int().positive(),
  kind: z.enum(TASK_KINDS).default(DEFAULT_KIND),
  titles: z.array(z.string().trim().min(1).max(200)).min(1, "Add at least one title").max(MAX_BATCH),
});
export type TaskBatch = z.input<typeof TaskBatchSchema>;

// A saved starting point for the new task form, kept per project.
export const TemplateInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  title: z.string().trim().max(200).default(""),
  description: z.string().max(20000).default(""),
});
export type TemplateInput = z.input<typeof TemplateInputSchema>;
export type TaskTemplate = {
  id: number;
  projectId: number;
  name: string;
  title: string;
  description: string;
};

// A line the project's agents are told to follow. The reviewer suggests them, and the user accepts or dismisses each.
export const RuleInputSchema = z.object({ text: z.string().trim().min(1, "Write the rule").max(300) });
export const RulePatchSchema = z
  .object({ status: z.enum(["active", "dismissed"]), text: z.string().trim().min(1).max(300) })
  .partial()
  .refine((p) => p.status !== undefined || p.text !== undefined, { message: "Nothing to change" });
export type RuleStatus = "suggested" | "active" | "dismissed";
export type ProjectRule = {
  id: number;
  projectId: number;
  text: string;
  status: RuleStatus;
  // The task whose review suggested it.
  sourceTaskId: number | null;
  createdAt: string;
};

// Move a task into a column, before another task in that column.
// beforeTaskId null puts it at the end.
export const TaskMoveSchema = z.object({
  column: ColumnSchema,
  beforeTaskId: z.number().int().nullable(),
});
export type TaskMove = z.infer<typeof TaskMoveSchema>;

// The researcher's output. The reviewer later checks the work against acceptanceCriteria.
export const PlanSchema = z.object({
  headline: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "What this plan does and the one thing the user should check. One plain sentence, under 160 characters. The board shows it first.",
    ),
  goal: z.string().trim().min(1).describe("One or two sentences: what done looks like."),
  context: z
    .string()
    .describe("What you found in the repo that the executor needs: relevant code, patterns, constraints."),
  acceptanceCriteria: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe("Concrete, checkable statements. The reviewer verifies each one."),
  filesToTouch: z
    .array(z.object({ path: z.string().trim().min(1), change: z.string().trim().min(1) }))
    .describe("Files to create or change, with what changes in each."),
  steps: z.array(z.string().trim().min(1)).min(1).describe("Ordered implementation steps."),
  testPlan: z.string().describe("How to verify the change: tests to add or run, manual checks."),
  risks: z.array(z.string().trim().min(1)).describe("What could go wrong or break."),
  assumptions: z
    .array(z.string().trim().min(1))
    .describe("Decisions you made without asking. The user reviews these."),
});
export type Plan = z.infer<typeof PlanSchema>;

export type PlanArtifact = {
  version: number;
  author: "agent" | "user";
  plan: Plan;
  createdAt: string;
};

// The output of a report task: a document to read, with the sources it rests on.
export const ReportDocSchema = z.object({
  headline: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The answer or main finding in one plain sentence, under 160 characters. The board shows it first."),
  summary: z.string().trim().min(1).describe("Two to four sentences a busy reader can stop at."),
  body: z.string().trim().min(1).describe("The full report in Markdown. Use headings and keep claims next to their sources."),
  sources: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        url: z.string().trim().max(2000).optional().describe("A web address, or a repository path for a file you read."),
        note: z.string().trim().optional().describe("What this source supports."),
      }),
    )
    .describe("Everything the report relies on."),
  openQuestions: z.array(z.string().trim().min(1)).describe("What you could not settle, so the reader knows what to check."),
});
export type ReportDoc = z.infer<typeof ReportDocSchema>;

export type ReportDocArtifact = {
  version: number;
  author: "agent" | "user";
  report: ReportDoc;
  createdAt: string;
};

// The output of a triage task: items found in the input, each a task to create or something to drop.
// Dot creates nothing until you accept an item.
export const PROPOSAL_ACTIONS = ["create_task", "drop"] as const;
export const MAX_PROPOSALS = 50;

export const ProposalItemSchema = z.object({
  action: z.enum(PROPOSAL_ACTIONS).describe("create_task proposes a task. drop lists something in the input that needs no task."),
  title: z.string().trim().min(1).max(200).describe("The task title, or what the dropped item was."),
  description: z
    .string()
    .trim()
    .max(20000)
    .optional()
    .describe("For create_task: what to do and why, enough for the agent that picks it up. Leave out for drop."),
  taskKind: z
    .enum(PROPOSABLE_KINDS)
    .optional()
    .describe("For create_task: code for a change to the repository, report for a question to research. Defaults to report in a workspace and code otherwise."),
  reason: z.string().trim().min(1).describe("Why this item is a task, or why it is dropped. One sentence."),
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const ProposalsSchema = z.object({
  headline: z.string().trim().min(1).max(200).describe("What the input held and what you propose, in one sentence."),
  summary: z.string().trim().min(1).describe("Two or three sentences: how you read the input and what you decided."),
  items: z.array(ProposalItemSchema).min(1).max(MAX_PROPOSALS).describe("Every actionable thing you found, in the order you would do them."),
});
export type Proposals = z.infer<typeof ProposalsSchema>;

// What you decided for the items of one proposals version. An index has no entry until you decide it.
export type ProposalDecision = { status: "accepted" | "rejected"; taskId: number | null };

export type ProposalsArtifact = {
  version: number;
  proposals: Proposals;
  decisions: Record<number, ProposalDecision>;
  createdAt: string;
};

export const ProposalDecideSchema = z.object({
  version: z.number().int().min(1),
  accept: z.array(z.number().int().min(0)).default([]),
  reject: z.array(z.number().int().min(0)).default([]),
});
export type ProposalDecide = z.infer<typeof ProposalDecideSchema>;

// The executor's output. Dot adds the commits itself from git, so the agent can't misreport them.
export const ExecutionReportSchema = z.object({
  headline: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "What you built and whether anything needs the user. One plain sentence, under 160 characters. The board shows it first.",
    ),
  summary: z.string().trim().min(1).describe("What you built, in a few sentences."),
  deviations: z
    .array(z.string().trim().min(1))
    .describe("Where you departed from the plan, and why. Empty if you followed it."),
  verification: z
    .array(
      z.object({
        command: z.string().trim().min(1).describe("The command you ran, or a short name for a manual check."),
        result: z.enum(["passed", "failed", "not_run"]),
        notes: z.string().describe("Relevant output or why it was not run."),
      }),
    )
    .describe("Tests, lint, typecheck and other checks you ran."),
  // Filled in later rounds: what you changed for each issue the reviewer raised.
  fixes: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("In a fix round: one line per reviewer issue you addressed, and how."),
  followUps: z.array(z.string().trim().min(1)).describe("Things left for later, outside this task's scope."),
});
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;

export type Commit = { hash: string; subject: string };

export type ExecutionArtifact = {
  version: number;
  report: ExecutionReport;
  commits: Commit[];
  createdAt: string;
};

const CheckSchema = z.object({
  command: z.string().trim().min(1).describe("The command you ran, or a short name for a manual check."),
  result: z.enum(["passed", "failed", "not_run"]),
  notes: z.string().describe("Relevant output or why it was not run."),
});

// The reviewer's verdict. Approve only with no blocking issues; request changes only with at least one.
export const ReviewSchema = z
  .object({
    verdict: z.enum(["approve", "changes_requested"]),
    headline: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "The verdict and the reason, for example the blocking problem. One plain sentence, under 160 characters. The board shows it first.",
      ),
    summary: z.string().trim().min(1).describe("Your overall assessment in a few sentences."),
    criteria: z
      .array(
        z.object({
          criterion: z.string().trim().min(1).describe("The acceptance criterion, as written in the plan."),
          status: z.enum(["met", "not_met", "unclear"]),
          evidence: z.string().trim().min(1).describe("What you checked: test output, code you read, a command you ran."),
        }),
      )
      .min(1)
      .describe("One entry per acceptance criterion in the plan."),
    issues: z
      .array(
        z.object({
          severity: z
            .enum(["blocking", "non_blocking"])
            .describe(
              "blocking: an unmet acceptance criterion, a failing test or build, a bug, a security problem. non_blocking: anything optional.",
            ),
          title: z.string().trim().min(1),
          details: z.string().trim().min(1).describe("What is wrong and what a fix looks like."),
          file: z.string().trim().optional(),
          line: z.number().int().positive().optional(),
        }),
      )
      .describe("Problems found. Empty if none."),
    checks: z.array(CheckSchema).describe("Tests, lint, typecheck and other checks you ran."),
    lessons: z
      .array(z.string().trim().min(1).max(300))
      .max(2)
      .optional()
      .describe(
        "Rules for future tasks in this project, when an issue shows a convention the agents keep missing. One short imperative sentence each, at most two. Leave it out otherwise. The user decides which become rules.",
      ),
  })
  .refine((r) => (r.verdict === "approve") === !r.issues.some((i) => i.severity === "blocking"), {
    message: "Use approve when there are no blocking issues, and changes_requested when there is at least one.",
  });
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewIssue = Review["issues"][number];

// round counts the reviewer's own verdicts since your last decision, so your change requests
// never use up the agents' fix rounds. reportVersion is the execution report that was reviewed.
export type ReviewArtifact = {
  version: number;
  round: number;
  reportVersion: number;
  author: "agent" | "user";
  review: Review;
  createdAt: string;
};

export type DiffFile = {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
};

// Committed changes on the task branch compared with its base. Uncommitted work is only flagged.
export type TaskDiff = {
  base: string;
  branch: string;
  commits: Commit[];
  files: DiffFile[];
  dirty: boolean;
};

export const RunStatusSchema = z.enum(["idle", "queued", "running", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// One agent session for one stage of a task. It can span many turns and process launches.
export type TaskEvent = {
  id: number;
  taskId: number;
  kind: "moved" | "needs_you" | "failed";
  // For "moved", the column key the task entered.
  detail: string;
  createdAt: string;
};

export type Run = {
  id: number;
  taskId: number;
  stage: AgentStage;
  sessionId: string;
  sessionStarted: boolean;
  // The Claude config folder the session was created in, so a resume finds it. Null is the default login.
  claudeConfigDir: string | null;
  claudeToken: string | null;
  status: RunStatus;
  costUsd: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AttachmentRef = { id: number; fileName: string; mediaType: string };

export type ChatRole = "user" | "agent" | "tool" | "system";
export type ChatKind = "text" | "tool" | "question" | "plan" | "document" | "proposals" | "report" | "review" | "error" | "status";

export type ChatData = {
  tool?: string;
  choices?: string[];
  answered?: boolean;
  planVersion?: number;
  proposalsVersion?: number;
  reportVersion?: number;
  reviewVersion?: number;
  attachments?: AttachmentRef[];
};

export type ChatMessage = {
  id: number;
  taskId: number;
  runId: number | null;
  stage: AgentStage | null;
  role: ChatRole;
  kind: ChatKind;
  text: string;
  data: ChatData | null;
  createdAt: string;
};

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const SendMessageSchema = z
  .object({
    stage: AgentStageSchema,
    text: z.string().max(100_000),
    attachmentIds: z.array(z.number().int().positive()).max(10).default([]),
  })
  .refine((m) => m.text.trim() !== "" || m.attachmentIds.length > 0, "Write a message or attach an image");
export type SendMessage = z.input<typeof SendMessageSchema>;

export const PlanUpdateSchema = z.object({ plan: PlanSchema });
// skipCi merges without waiting for a build, for repositories that have no CI.
export const MergeSchema = z.object({ skipCi: z.boolean().default(false) });
export type MergeRequest = z.input<typeof MergeSchema>;

export const SendBackSchema =z.object({ notes: z.string().trim().min(1, "Say what to change").max(20_000) });
export type SendBack = z.infer<typeof SendBackSchema>;

// Moves some of a plan's steps into a new task that waits for this one. Steps are positions, from 0.
export const PlanSplitSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  steps: z.array(z.number().int().min(0)).min(1, "Pick at least one step").max(200),
});
export type PlanSplit = z.infer<typeof PlanSplitSchema>;

export const RetrySchema =z.object({ stage: AgentStageSchema });

// Server-sent events. Clients refetch on these.
export type BoardEvent =
  | { type: "projects.changed" }
  // taskId is set when one task changed, so an open task panel can ignore the others.
  | { type: "tasks.changed"; projectId: number; taskId?: number }
  | { type: "messages.changed"; taskId: number };

// Artifacts saved before the headline field existed have none. Fall back to the first sentence of the
// text that sums them up, so every panel can show something short.
export function firstSentence(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? clean : clean.slice(0, end + 1);
  return sentence.length > max ? `${sentence.slice(0, max - 3).trimEnd()}...` : sentence;
}
// The type says a headline is always there, but rows saved earlier have none.
type MaybeHeadline = { headline?: string };
export const planHeadline = (plan: Plan & MaybeHeadline) => plan.headline?.trim() || firstSentence(plan.goal);
export const reportDocHeadline = (doc: ReportDoc & MaybeHeadline) => doc.headline?.trim() || firstSentence(doc.summary);
export const reportHeadline = (report: ExecutionReport & MaybeHeadline) => report.headline?.trim() || firstSentence(report.summary);
export const reviewHeadline = (review: Review & MaybeHeadline) => review.headline?.trim() || firstSentence(review.summary);
