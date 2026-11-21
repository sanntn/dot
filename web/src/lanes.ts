import { KINDS, LANES, laneOf, type Column, type Lane, type Task } from "@dot/shared";

export { LANES, laneOf, type Lane };

export const LANE_LABELS: Record<Lane, string> = {
  inbox: "Inbox",
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
};

// Where a card lands when it is dropped into a lane it does not already belong to.
// Needs you lands on the task's first gate column, which depends on its kind.
export function laneEntry(task: Pick<Task, "kind">, lane: Lane): Column {
  switch (lane) {
    case "inbox":
      return "inbox";
    case "working":
      return "research";
    case "needs_you":
      return KINDS[task.kind].gates[0] ?? "plan_review";
    case "done":
      return "done";
  }
}

// The pipeline condensed to a few steps for the card's progress bar. The steps come from the task's kind.
export function stepOf(task: Task): { index: number; label: string; total: number } | null {
  const kind = KINDS[task.kind];
  const index = kind.stepOf[task.column];
  const label = index === undefined ? undefined : kind.steps[index];
  if (index === undefined || label === undefined) return null;
  return { index, label, total: kind.steps.length };
}

export function canRetry(task: Task): boolean {
  return task.agentState === "failed" && KINDS[task.kind].startable.includes(task.column);
}

export function canStart(task: Task): boolean {
  return task.column === "inbox" && task.agentState === "idle" && task.blockedBy.length === 0;
}

export function isActive(task: Task): boolean {
  return task.agentState === "running" || task.agentState === "queued";
}

// One plain sentence on what the card is waiting for, taken from fields the task already carries.
export function statusLine(task: Task): string | null {
  if (task.blockedBy.length > 0 && task.column === "inbox") {
    return `Blocked by ${task.blockedBy.map((b) => `#${b.number}`).join(", ")}${task.autoStart ? ", starts by itself" : ""}`;
  }
  if (task.agentState === "failed") return "The agent stopped with an error";
  if (task.needsInput) return "The agent asked you a question";
  if (task.agentState === "queued") return "Waiting for a free agent slot";
  switch (task.column) {
    case "research":
      return task.agentState === "running" ? (task.kind === "report" ? "Researching" : "Reading the codebase") : null;
    case "report_review":
      return "Report ready for you to read";
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
