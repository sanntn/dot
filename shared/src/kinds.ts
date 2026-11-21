import type { AgentStage, Column } from "./index.ts";

// What a task is for. A kind decides which columns the task passes through, which stages run, and
// which columns wait for you. New kinds add an entry to KINDS.
export const TASK_KINDS = ["code", "report", "triage"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type KindDef = {
  label: string;
  // One line for the kind picker.
  blurb: string;
  // Every column a task of this kind can sit in, in board order.
  columns: readonly Column[];
  // Columns where the task waits for you, so its card sits in the Needs you lane.
  gates: readonly Column[];
  // The progress steps on the card, and the step each column belongs to.
  steps: readonly string[];
  stepOf: Partial<Record<Column, number>>;
  // The column each agent stage works in. A stage missing here does not exist for the kind.
  stageColumns: Partial<Record<AgentStage, Column>>;
  // Columns where the server can start an agent.
  startable: readonly Column[];
  // Names for agent stages that differ from the defaults in STAGE_LABELS.
  stageLabels: Partial<Record<AgentStage, string>>;
  // The MCP tool that ends the research stage by handing its output to you.
  submitTool: string;
};

export const KINDS: Record<TaskKind, KindDef> = {
  code: {
    label: "Code change",
    blurb: "Research, plan, implement, review and merge a pull request.",
    columns: ["inbox", "research", "plan_review", "execute", "review", "merge_approval", "merge", "done"],
    gates: ["plan_review", "merge_approval"],
    steps: ["Research", "Execute", "Review", "Merge"],
    stepOf: { research: 0, plan_review: 0, execute: 1, review: 2, merge_approval: 3, merge: 3 },
    stageColumns: { research: "research", execute: "execute", review: "review" },
    startable: ["inbox", "research", "execute", "review"],
    stageLabels: {},
    submitTool: "submit_plan",
  },
  report: {
    label: "Report",
    blurb: "Research a question and hand back a written report with sources. No code changes.",
    columns: ["inbox", "research", "report_review", "done"],
    gates: ["report_review"],
    steps: ["Research", "Review"],
    stepOf: { research: 0, report_review: 1 },
    stageColumns: { research: "research" },
    startable: ["inbox", "research"],
    stageLabels: { research: "Report agent" },
    submitTool: "submit_report",
  },
  triage: {
    label: "Triage",
    blurb: "Read pasted notes, a list or files and propose tasks. Nothing is created until you accept it.",
    columns: ["inbox", "research", "triage_review", "done"],
    gates: ["triage_review"],
    steps: ["Triage", "Review"],
    stepOf: { research: 0, triage_review: 1 },
    stageColumns: { research: "research" },
    startable: ["inbox", "research"],
    stageLabels: { research: "Triage agent" },
    submitTool: "submit_proposals",
  },
};

export const DEFAULT_KIND: TaskKind = "code";

// Which task kinds a project accepts. A workspace has no repository, so it cannot hold code changes.
export function taskKindsFor(projectKind: string): readonly TaskKind[] {
  return projectKind === "workspace" ? TASK_KINDS.filter((k) => k !== "code") : TASK_KINDS;
}

// The registry entry for a kind. A value this build does not know, such as a row saved by a newer
// build, reads as the default kind instead of crashing the board.
export function kindDef(kind: string): KindDef {
  return KINDS[kind as TaskKind] ?? KINDS[DEFAULT_KIND];
}

// The kind a new task gets in a project when none is given: code in a repository, report in a workspace.
export function defaultTaskKind(projectKind: string): "code" | "report" {
  return projectKind === "workspace" ? "report" : "code";
}

// The kinds a triage agent may propose. Triage does not propose more triage.
export const PROPOSABLE_KINDS = ["code", "report"] as const satisfies readonly TaskKind[];

// The column an agent stage works in. Outside it, the agent is only chatting.
export function stageColumn(kind: TaskKind, stage: AgentStage): Column | null {
  return kindDef(kind).stageColumns[stage] ?? null;
}
