import type { ExecutionArtifact, Plan, Project, ReviewIssue, Task } from "@dot/shared";
import { planMarkdown } from "./executor.ts";
import { RESEARCHER_ALLOWED_TOOLS, RESEARCHER_DENIED_TOOLS } from "./researcher.ts";

export const REVIEWER_TOOLS = ["Read", "Glob", "Grep", "Bash"];

// Read-only like the researcher, plus the project's own test, lint and typecheck commands exactly
// as configured. Extra arguments are not allowed: "npm test -- -u" would rewrite snapshot files.
// The commands still run code from the task branch, so the reviewer is ref-audited like the executor.
export function reviewerAllowedTools(project: Project): string[] {
  const commands = [project.testCommand, project.lintCommand, project.typecheckCommand].filter(
    (c): c is string => Boolean(c),
  );
  return [
    ...RESEARCHER_ALLOWED_TOOLS.filter((t) => !t.startsWith("mcp__") && !t.startsWith("Web")),
    ...commands.map((cmd) => `Bash(${cmd})`),
    "mcp__dot__ask_human",
    "mcp__dot__submit_review",
  ];
}

export const REVIEWER_DENIED_TOOLS = RESEARCHER_DENIED_TOOLS;

export const REVIEWER_SYSTEM_PROMPT = `
You are the reviewer agent in Dot, a kanban board where Claude agents carry a task from idea to merged code.
A research agent wrote a plan, the user approved it, and an executor agent implemented it on a git branch.
Your job is to check that work before it goes to the user for merge approval.

How to work:
- You are in the task's git worktree. You cannot edit files. Your shell allows read-only git commands
  (git diff, git log, git show and so on), ls, wc, pwd, and the project's test, lint and typecheck commands
  exactly as listed in the brief, with no extra arguments. Run one command per Bash call.
  Chained commands, extra arguments and anything else are denied.
- Start from the diff against the base branch, then read the changed code in context.
- Run the project's test, lint and typecheck commands when they exist.
- Check each acceptance criterion in the plan and record it as met, not_met or unclear, with evidence.
- File issues. Blocking: an acceptance criterion is not met, a test, lint or typecheck fails, a bug,
  a security problem, or a change that clearly does something the plan didn't ask for. Non-blocking: anything
  optional, such as style, naming, small cleanups or follow-up ideas. Don't block on taste.
- Call submit_review. The verdict is approve when there are no blocking issues, and changes_requested when there
  is at least one. Blocking issues go back to the executor, which fixes them in another round.
- After submit_review succeeds, end your turn with a short summary.
- Use ask_human only when the plan itself is ambiguous in a way you can't judge.

In a later round you get the executor's fixes. Review the whole change again, not only the fixes.
The user may chat with you. Answer their questions.
`.trim();

export function reviewerBrief(
  task: Task,
  project: Project,
  plan: Plan,
  planVersion: number,
  report: ExecutionArtifact,
  round: number,
  baseRef: string,
): string {
  const commands = [
    project.testCommand && `test: ${project.testCommand}`,
    project.lintCommand && `lint: ${project.lintCommand}`,
    project.typecheckCommand && `typecheck: ${project.typecheckCommand}`,
  ].filter(Boolean);
  const r = report.report;

  return [
    `Task #${task.number}:${task.title}`,
    "",
    task.description.trim() || "(No description given.)",
    "",
    `Review round ${round}. The work is on branch ${task.branch}, created from ${project.baseBranch}.`,
    `See it with: git diff ${baseRef}...HEAD` +
      (baseRef === project.baseBranch ? "" : ` (${baseRef} is Dot's fetched copy of origin's ${project.baseBranch})`),
    commands.length > 0 ? `Project commands: ${commands.join(", ")}` : "Project commands: none configured.",
    "",
    `# Approved plan (version ${planVersion})`,
    "",
    planMarkdown(plan),
    "",
    "# Executor's report",
    "",
    r.summary,
    r.deviations.length > 0 ? `\nDeviations from the plan:\n${r.deviations.map((d) => `- ${d}`).join("\n")}` : "",
    `\nCommits:\n${report.commits.map((c) => `- ${c.hash} ${c.subject}`).join("\n")}`,
    "",
    "Review the work and call submit_review.",
  ].join("\n");
}

// What the reviewer gets in later rounds, in its existing session.
export function reviewerFollowUp(report: ExecutionArtifact, round: number, base: string): string {
  const fixes = report.report.fixes ?? [];
  return [
    `Review round ${round}. The executor addressed your issues and submitted a new report.`,
    "",
    report.report.summary,
    fixes.length > 0 ? `\nFixes:\n${fixes.map((f) => `- ${f}`).join("\n")}` : "",
    `\nCommits on the branch now:\n${report.commits.map((c) => `- ${c.hash} ${c.subject}`).join("\n")}`,
    "",
    `Review the whole change again (git diff ${base}...HEAD), rerun the checks, and call submit_review.`,
  ].join("\n");
}

// What the executor gets when the review, or you, request changes. round is the task's review
// number, the one shown everywhere. roundsLeft is how many more reviews the loop allows before
// Dot stops it and asks the user.
export function fixRequest(issues: ReviewIssue[], round: number, roundsLeft: number, notes?: string): string {
  const describe = (i: ReviewIssue) =>
    `- ${i.title}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : ""}\n  ${i.details.replace(/\n/g, "\n  ")}`;
  const blocking = issues.filter((i) => i.severity === "blocking");
  const optional = issues.filter((i) => i.severity === "non_blocking");
  return [
    notes
      ? `The user reviewed your work and requested changes:\n\n${notes}`
      : `The reviewer requested changes in review round ${round}. ` +
        `${roundsLeft} more review${roundsLeft === 1 ? "" : "s"} before Dot stops the loop and asks the user.`,
    blocking.length > 0 ? `\nBlocking issues, fix all of these:\n${blocking.map(describe).join("\n")}` : "",
    optional.length > 0 ? `\nOptional notes, fix only if trivial:\n${optional.map(describe).join("\n")}` : "",
    "",
    "Fix them, commit, and call submit_execution_report again. List what you changed for each issue under fixes.",
  ].join("\n");
}
