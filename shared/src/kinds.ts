import type { AgentStage, Column } from "./index.ts";

// What a task is for. A kind decides which columns the task passes through, which stages run, and
// which columns wait for you. Code changes and reports exist so far. New kinds add an entry to KINDS.
export const TASK_KINDS = ["code", "report"] as const;
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
  },
};

export const DEFAULT_KIND: TaskKind = "code";

// The column an agent stage works in. Outside it, the agent is only chatting.
export function stageColumn(kind: TaskKind, stage: AgentStage): Column | null {
  return KINDS[kind].stageColumns[stage] ?? null;
}
