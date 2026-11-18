import type { Column, Task } from "@dot/shared";

// The board shows four lanes. Each lane groups the pipeline columns that mean the same thing to the person watching.
export const LANES = ["inbox", "working", "needs_you", "done"] as const;
export type Lane = (typeof LANES)[number];

export const LANE_LABELS: Record<Lane, string> = {
  inbox: "Inbox",
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
};

// Where a card lands when it is dropped into a lane it does not already belong to.
export const LANE_ENTRY: Record<Lane, Column> = {
  inbox: "inbox",
  working: "research",
  needs_you: "plan_review",
  done: "done",
};

// A task waits for you at plan review, at merge approval, or whenever its agent has a question or failed.
export function laneOf(task: Task): Lane {
  if (task.column === "inbox") return "inbox";
  if (task.column === "done") return "done";
  if (task.column === "plan_review" || task.column === "merge_approval") return "needs_you";
  if (task.needsInput || task.agentState === "failed") return "needs_you";
  return "working";
}

// The pipeline condensed to four steps for the card's progress bar.
export const STEPS = ["Research", "Execute", "Review", "Merge"] as const;

const STEP_OF: Partial<Record<Column, number>> = {
  research: 0,
  plan_review: 0,
  execute: 1,
  review: 2,
  merge_approval: 3,
  merge: 3,
};

export function stepOf(task: Task): { index: number; label: string; total: number } | null {
  const index = STEP_OF[task.column];
  const label = index === undefined ? undefined : STEPS[index];
  if (index === undefined || label === undefined) return null;
  return { index, label, total: STEPS.length };
}
