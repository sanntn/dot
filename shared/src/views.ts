import type { Column, ProposalsArtifact, Task, TaskKind } from "./index.ts";

// A report task with a written document, for the Documents view. The list carries the headline only.
// The view fetches the whole document when you pick one.
export type DocumentEntry = {
  task: Task;
  projectName: string;
  version: number;
  headline: string;
  summary: string;
  updatedAt: string;
};

// A triage task waiting for you, with the proposals the agent submitted, for the Triage view.
export type TriageEntry = {
  task: Task;
  projectName: string;
  artifact: ProposalsArtifact;
};

export type FeedEvent = "created" | "moved" | "needs_you" | "failed";

// One thing that happened to a task, for the Feed view. Moves appear only into a gate or Done.
export type FeedItem = {
  at: string;
  event: FeedEvent;
  // For "moved", the column the task entered.
  detail: Column | "";
  taskId: number;
  projectId: number;
  projectName: string;
  number: number;
  title: string;
  kind: TaskKind;
  // The schedule that made the task, when one did.
  schedule: string | null;
};
