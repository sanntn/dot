import {
  defaultTaskKind,
  kindDef,
  ExecutionReportSchema,
  MAX_REVIEW_ROUNDS,
  PlanSchema,
  ProposalsSchema,
  ReportDocSchema,
  ReviewSchema,
  type Run,
} from "@dot/shared";
import { z } from "zod";
import { fixRequest } from "./agents/reviewer.ts";
import { commitsAhead, resolveBaseRef, uncommittedChanges } from "./git.ts";
import { defineTool, type McpTool } from "./mcp.ts";
import type { Store } from "./store.ts";

// The tools an agent calls back into Dot with, one set per stage. Each handler checks the task's
// state first, because a tool call can arrive after the task has moved on.

// The part of a run's in-memory state that the tools change. The orchestrator acts on it when the
// agent's turn or process ends.
export type ToolState = {
  // The stage's outcome (a plan, a report, a review or a question) arrived, so no nudge is needed.
  outcome: boolean;
  // The reviewer starts once this process exits.
  reviewOnExit: boolean;
  // The executor's fix round starts once this process exits.
  fixOnExit: { executorRunId: number; prompt: string } | null;
};

export type ToolDeps = { store: Store; publish: (taskId: number) => void };

export function agentTools({ store, publish }: ToolDeps, run: Run, live: ToolState): McpTool[] {
  const runId = run.id;

  const askHuman = defineTool({
    name: "ask_human",
    description:
      "Ask the user a question when a decision is theirs to make. Then end your turn: the answer arrives as the next user message.",
    schema: z.object({
      question: z.string().trim().min(1).describe("One focused question."),
      choices: z.array(z.string().trim().min(1)).max(6).optional().describe("Suggested answers, if any."),
    }),
    handler: ({ question, choices }) => {
      store.addMessage({
        taskId: run.taskId,
        runId,
        role: "agent",
        kind: "question",
        text: question,
        data: choices && choices.length > 0 ? { choices } : null,
      });
      store.setNeedsInput(run.taskId, true);
      live.outcome = true;
      publish(run.taskId);
      return { text: "Your question was sent to the user. End your turn now. Their answer arrives as the next user message." };
    },
  });

  const submitPlan = defineTool({
    name: "submit_plan",
    description:
      "Submit the implementation plan for the user to review. Each call saves a new version. Only works before the plan is approved.",
    schema: PlanSchema,
    handler: (plan) => {
      const task = store.getTask(run.taskId);
      if (task.column !== "research" && task.column !== "plan_review") {
        return { text: "The plan is already approved and can no longer change.", isError: true };
      }
      const saved = store.addPlan(run.taskId, runId, "agent", plan);
      store.addMessage({
        taskId: run.taskId,
        runId,
        role: "agent",
        kind: "plan",
        text: `Submitted plan v${saved.version}: ${plan.headline}`,
        data: { planVersion: saved.version },
      });
      if (task.column === "research") store.moveTask(task.id, { column: "plan_review", beforeTaskId: null });
      live.outcome = true;
      publish(run.taskId);
      return {
        text: `Plan saved as version ${saved.version} and sent to the user for review. End your turn now with a short summary of the plan.`,
      };
    },
  });

  const submitReport = defineTool({
    name: "submit_report",
    description:
      "Submit the finished report for the user to read. Each call saves a new version. Works while the report is in Research or waiting for review.",
    schema: ReportDocSchema,
    handler: (report) => {
      const task = store.getTask(run.taskId);
      if (task.column !== "research" && task.column !== "report_review") {
        return { text: "The report is already approved and can no longer change.", isError: true };
      }
      const saved = store.addReportDoc(run.taskId, runId, "agent", report);
      store.addMessage({
        taskId: run.taskId,
        runId,
        role: "agent",
        kind: "document",
        text: `Submitted report v${saved.version}: ${report.headline}`,
        data: { reportVersion: saved.version },
      });
      if (task.column === "research") store.moveTask(task.id, { column: "report_review", beforeTaskId: null });
      live.outcome = true;
      publish(run.taskId);
      return {
        text: `Report saved as version ${saved.version} and sent to the user. End your turn now with a short summary of what you found.`,
      };
    },
  });

  const submitProposals = defineTool({
    name: "submit_proposals",
    description:
      "Submit the tasks you propose for the user to accept or reject. Each call saves a new version. Nothing is created until the user accepts an item.",
    schema: ProposalsSchema,
    handler: (proposals) => {
      const task = store.getTask(run.taskId);
      if (task.column !== "research" && task.column !== "triage_review") {
        return { text: "Triage is already finished and can no longer change.", isError: true };
      }
      // A workspace has no repository, so a proposed code change could never be created.
      const project = store.getProject(task.projectId);
      if (project.kind === "workspace" && proposals.items.some((i) => i.taskKind === "code")) {
        return { text: "This project is a workspace with no repository, so it cannot hold code tasks. Use report, then submit again.", isError: true };
      }
      if (!proposals.items.some((i) => i.action === "create_task")) {
        return { text: "Every item is a drop. If nothing here is actionable, say so to the user and end your turn without submitting.", isError: true };
      }
      // Settle the kind now, so the list you review shows what accepting will create.
      const defaultKind = defaultTaskKind(project.kind);
      const settled = {
        ...proposals,
        items: proposals.items.map((i) => (i.action === "create_task" && !i.taskKind ? { ...i, taskKind: defaultKind } : i)),
      };
      const saved = store.addProposals(run.taskId, runId, settled);
      store.addMessage({
        taskId: run.taskId,
        runId,
        role: "agent",
        kind: "proposals",
        text: `Submitted proposals v${saved.version}: ${proposals.headline}`,
        data: { proposalsVersion: saved.version },
      });
      if (task.column === "research") store.moveTask(task.id, { column: "triage_review", beforeTaskId: null });
      live.outcome = true;
      publish(run.taskId);
      return {
        text: `Proposals saved as version ${saved.version} and sent to the user. End your turn now with a short summary of what you found.`,
      };
    },
  });

  const submitExecutionReport = defineTool({
    name: "submit_execution_report",
    description:
      "Report that the plan is implemented and committed. Rejected while the worktree has uncommitted changes or the branch has no commits.",
    schema: ExecutionReportSchema,
    handler: async (report) => {
      const task = store.getTask(run.taskId);
      if (task.column !== "execute") {
        return { text: "This task is no longer in the Execute column, so no report is needed.", isError: true };
      }
      if (!task.worktreePath) return { text: "This task has no worktree.", isError: true };
      const project = store.getProject(task.projectId);

      // Check git, not the agent's word: the work must be committed on the branch.
      const dirty = await uncommittedChanges(task.worktreePath);
      if (dirty) {
        // Cap the listing: an unignored node_modules alone would flood the agent's context.
        const lines = dirty.split("\n");
        const shown = lines.slice(0, 30).join("\n");
        const more = lines.length > 30 ? `\n...and ${lines.length - 30} more. Check .gitignore.` : "";
        return {
          text: `The worktree has uncommitted changes. Commit them (or remove them if they are not part of the work), then call submit_execution_report again.\n\n${shown}${more}`,
          isError: true,
        };
      }
      const commits = await commitsAhead(task.worktreePath, await resolveBaseRef(project.repoPath, project.baseBranch));
      if (commits.length === 0) {
        return { text: `The branch has no commits ahead of ${project.baseBranch}. Commit your work first.`, isError: true };
      }

      const saved = store.addExecutionReport(run.taskId, runId, report, commits);
      store.addMessage({
        taskId: run.taskId,
        runId,
        role: "agent",
        kind: "report",
        text: `Submitted the execution report (${commits.length} commit${commits.length === 1 ? "" : "s"}): ${report.headline}`,
        data: { reportVersion: saved.version },
      });
      store.moveTask(task.id, { column: "review", beforeTaskId: null });
      live.outcome = true;
      live.reviewOnExit = true;
      publish(run.taskId);
      return { text: "Report saved. The task moves to review. End your turn now with a short summary of what you built." };
    },
  });

  const submitReview = defineTool({
    name: "submit_review",
    description:
      "Submit your review of the executor's work. approve sends it to the user for merge approval; changes_requested sends the blocking issues back to the executor.",
    schema: ReviewSchema,
    handler: async (review) => {
      const task = store.getTask(run.taskId);
      if (task.column !== "review") {
        return { text: "This task is no longer in Review, so no review is needed.", isError: true };
      }
      const plan = store.latestPlan(run.taskId);
      const report = store.latestExecutionReport(run.taskId);
      if (!plan || !report) return { text: "There is no plan or report to review.", isError: true };
      const expected = plan.plan.acceptanceCriteria.length;
      if (review.criteria.length < expected) {
        return {
          text: `The plan has ${expected} acceptance criteria and your review covers ${review.criteria.length}. Add an entry for each one.`,
          isError: true,
        };
      }

      const cycleRound = task.reviewRound + 1;
      const saved = store.addReview(run.taskId, runId, cycleRound, report.version, review);
      store.setReviewRound(run.taskId, cycleRound);
      const round = saved.version;
      // Lessons wait as suggestions until the user accepts them. They never reach an agent before that.
      store.suggestRules(task.projectId, task.id, review.lessons ?? []);
      const blocking = review.issues.filter((i) => i.severity === "blocking");
      live.outcome = true;

      // Running the project's checks can leave files behind (coverage reports, caches). Say so,
      // or the executor's next report is rejected for changes it didn't make.
      const leftovers = task.worktreePath ? await uncommittedChanges(task.worktreePath).catch(() => "") : "";
      const leftoverNote = leftovers
        ? `The review's checks left these files changed or untracked in the worktree:\n\n${leftovers.split("\n").slice(0, 30).join("\n")}`
        : "";
      if (leftoverNote) {
        store.addMessage({ taskId: run.taskId, runId, role: "system", kind: "status", text: leftoverNote });
      }

      if (review.verdict === "approve") {
        store.addMessage({
          taskId: run.taskId,
          runId,
          role: "agent",
          kind: "review",
          text: `Approved in round ${round}: ${review.headline}`,
          data: { reviewVersion: saved.version },
        });
        store.moveTask(task.id, { column: "merge_approval", beforeTaskId: null });
        publish(run.taskId);
        return { text: "Review saved. The change goes to the user for merge approval. End your turn now with a short summary." };
      }

      store.addMessage({
        taskId: run.taskId,
        runId,
        role: "agent",
        kind: "review",
        text: `Requested changes in round ${round}: ${review.headline}`,
        data: { reviewVersion: saved.version },
      });

      // Out of rounds: stop the loop and let the user decide.
      if (cycleRound >= MAX_REVIEW_ROUNDS) {
        store.setNeedsInput(run.taskId, true);
        store.addMessage({
          taskId: run.taskId,
          runId: null,
          role: "system",
          kind: "status",
          text: `The reviewer requested changes ${MAX_REVIEW_ROUNDS} rounds in a row, so Dot stopped the loop. Approve the change as it is, or request changes yourself.`,
        });
        publish(run.taskId);
        return { text: "Review saved. The review round limit is reached, so the user decides next. End your turn now with a short summary." };
      }

      const executorRun = store.latestRun(run.taskId, "execute");
      if (!executorRun) return { text: "This task has no executor to send the issues to.", isError: true };
      store.moveTask(task.id, { column: "execute", beforeTaskId: null });
      // The executor starts once this reviewer's process exits, so the two never share the worktree.
      live.fixOnExit = {
        executorRunId: executorRun.id,
        prompt: [fixRequest(review.issues, round, MAX_REVIEW_ROUNDS - cycleRound), leftoverNote].filter(Boolean).join("\n\n"),
      };
      publish(run.taskId);
      return { text: "Review saved. The issues go back to the executor. End your turn now with a short summary." };
    },
  });

  if (run.stage === "research") {
    // The kind names the tool that ends its research stage.
    const submit = { submit_report: submitReport, submit_proposals: submitProposals }[kindDef(store.getTask(run.taskId).kind).submitTool];
    return [askHuman, submit ?? submitPlan];
  }
  if (run.stage === "execute") return [askHuman, submitExecutionReport];
  return [askHuman, submitReview];
}
