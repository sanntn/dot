import { LANES, laneOf, type Column, type Lane, type Task } from "@dot/shared";

export { LANES, laneOf, type Lane };

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

// Columns where the server can start an agent. Dot refuses anything else with a 409.
const STARTABLE: readonly Column[] = ["inbox", "research", "execute", "review"];

export function canRetry(task: Task): boolean {
  return task.agentState === "failed" && STARTABLE.includes(task.column);
}

export function canStart(task: Task): boolean {
  return task.column === "inbox" && task.agentState === "idle";
}

export function isActive(task: Task): boolean {
  return task.agentState === "running" || task.agentState === "queued";
}

// One plain sentence on what the card is waiting for, taken from fields the task already carries.
export function statusLine(task: Task): string | null {
  if (task.agentState === "failed") return "The agent stopped with an error";
  if (task.needsInput) return "The agent asked you a question";
  if (task.agentState === "queued") return "Waiting for a free agent slot";
  switch (task.column) {
    case "research":
      return task.agentState === "running" ? "Reading the codebase" : null;
    case "plan_review":
      return "Plan ready for you to review";
    case "execute":
      return task.agentState === "running" ? "Writing code" : null;
    case "review":
      return task.agentState === "running"
        ? `Reviewing, round ${task.reviewRound + 1}`
        : task.reviewRound > 0
          ? `Review round ${task.reviewRound} done`
          : null;
    case "merge_approval":
      return "Ready to merge when you approve";
    case "merge":
      return "Merging";
    default:
      return null;
  }
}
