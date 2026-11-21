import type { TaskKind } from "./kinds.ts";

// The most rows the Outputs list returns. The dialog says so when it reaches this many.
export const OUTPUTS_LIMIT = 100;

// What a finished task left behind: a code change's merged pull request, a report, or the tasks a triage made.
// One row per task in the Done column, across kinds.
export type Output = {
  taskId: number;
  projectId: number;
  projectName: string;
  number: number;
  title: string;
  kind: TaskKind;
  // The headline and summary of the task's last result. Empty when the task has none, such as one dragged to Done.
  headline: string;
  summary: string;
  // The pull request, for a code change.
  url: string | null;
  finishedAt: string;
};
