import type { Plan, Project, Task } from "@dot/shared";

export const EXECUTOR_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];

// The executor has to build, test and commit, so its shell is open. --restricted keeps its file tools
// inside the worktree. These deny rules stop it from leaving its branch or touching anything shared
// with your main checkout: remotes, other branches, other worktrees and git config.
export const EXECUTOR_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "mcp__dot__ask_human",
  "mcp__dot__submit_execution_report",
];

export const EXECUTOR_DENIED_TOOLS = [
  "Bash(git push*)",
  "Bash(git pull*)",
  "Bash(git fetch*)",
  "Bash(git remote*)",
  "Bash(git checkout*)",
  "Bash(git switch*)",
  "Bash(git worktree*)",
  "Bash(git branch*)",
  "Bash(git tag*)",
  "Bash(git config*)",
  "Bash(git update-ref*)",
  "Bash(git -C*)",
  "Bash(git --git-dir*)",
  "Bash(git --work-tree*)",
];

export const EXECUTOR_SYSTEM_PROMPT = `
You are the executor agent in Dot, a kanban board where Claude agents carry a task from idea to merged code.
A research agent wrote a plan, and the user approved it. Your job is to implement that plan.
After you, a reviewer agent checks your work against the plan's acceptance criteria. If it finds problems,
you get its list of issues in this same session and fix them.

How to work:
- You are in a git worktree on the task's own branch. Commit your work to this branch as you go,
  with clear commit messages. Do not push, pull, switch branches, create worktrees or tags, or change git config.
  Those commands are denied.
- Follow the plan. If you have to depart from it in a small way, do so and list it as a deviation in your report.
  If the plan turns out to be wrong in a way that changes scope or behavior, call ask_human and end your turn.
- Keep the change focused on the task. Don't refactor unrelated code.
- Install dependencies if the project needs them. Run the project's test, lint and typecheck commands
  when they exist, and fix what your change broke.
- When the work is done, commit everything, then call submit_execution_report. It is rejected while there are
  uncommitted changes or when the branch has no commits.
- After the report is accepted, end your turn with a short summary.

The user may chat with you while you work or afterwards. Answer their questions and act on their instructions.
`.trim();

export function planMarkdown(plan: Plan): string {
  const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return [
    `## Goal\n${plan.goal}`,
    `## Acceptance criteria\n${list(plan.acceptanceCriteria)}`,
    `## Context\n${plan.context || "(none)"}`,
    `## Files to touch\n${list(plan.filesToTouch.map((f) => `${f.path}: ${f.change}`))}`,
    `## Steps\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `## Test plan\n${plan.testPlan || "(none)"}`,
    `## Assumptions\n${list(plan.assumptions)}`,
    `## Risks\n${list(plan.risks)}`,
  ].join("\n\n");
}

export function executorBrief(task: Task, project: Project, plan: Plan, planVersion: number, branch: string): string {
  const commands = [
    project.testCommand && `test: ${project.testCommand}`,
    project.lintCommand && `lint: ${project.lintCommand}`,
    project.typecheckCommand && `typecheck: ${project.typecheckCommand}`,
  ].filter(Boolean);

  return [
    `Task #${task.number}:${task.title}`,
    "",
    task.description.trim() || "(No description given.)",
    "",
    `Project: ${project.name}`,
    `You are on branch ${branch}, created from ${project.baseBranch}.`,
    commands.length > 0 ? `Project commands: ${commands.join(", ")}` : "Project commands: none configured.",
    "",
    `# Approved plan (version ${planVersion})`,
    "",
    planMarkdown(plan),
    "",
    "Implement this plan, commit your work, and call submit_execution_report when you are done.",
  ].join("\n");
}
