import type { Project, Task } from "@dot/shared";
import { importedNote, memoryNote, rulesNote } from "./rules.ts";

// Built-in tools the researcher has at all. Write, Edit and the rest are not even loaded.
export const RESEARCHER_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];

// Read-only shell commands, with any arguments. Everything else is denied, since nobody answers
// permission prompts. Only commands with no argument that writes files or runs programs belong here:
// rg (--pre), git grep (-O) and tree (-o) are left out on purpose. Grep and Glob cover them.
export const READ_ONLY_COMMANDS = ["git log", "git show", "git diff", "git status", "git ls-files", "git blame", "git rev-parse", "ls", "wc"];

// Commands allowed only exactly as written. "git branch" with arguments can create or delete branches.
export const EXACT_COMMANDS = ["pwd", "git branch", "git branch -a", "git branch -r", "git branch -v", "git branch --show-current"];

export const RESEARCHER_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  ...READ_ONLY_COMMANDS.flatMap((cmd) => [`Bash(${cmd})`, `Bash(${cmd} *)`]),
  ...EXACT_COMMANDS.map((cmd) => `Bash(${cmd})`),
  "mcp__dot__ask_human",
  "mcp__dot__remember",
  "mcp__dot__submit_plan",
];

// Deny rules win over allow rules. git log, show and diff can write files with --output.
// git diff --no-index compares two paths on disk and prints them, so it reads any file the user
// can read, outside the repository too.
export const RESEARCHER_DENIED_TOOLS = ["Bash(*--output*)", "Bash(*--no-index*)", "Bash(*GIT_*)"];

// The shell commands the research-stage agents may run, for their prompts. Built from the allow lists, so it cannot drift.
export const SHELL_COMMANDS_TEXT = `${[...READ_ONLY_COMMANDS, "git branch (no arguments)"].join(", ")} and pwd`;

export const RESEARCHER_SYSTEM_PROMPT = `
You are the research agent in Dot, a kanban board where Claude agents carry a task from idea to merged code.
Your stage comes first. After you, an executor agent implements your plan in a git worktree, a reviewer agent
checks the result against your acceptance criteria, and a merge step opens a pull request on Bitbucket or GitHub.
The user approves your plan before the executor starts.

Your job is to understand the task well enough that the executor can do it without asking anyone.

How to work:
- Read the task, then investigate the repository: find the relevant code, conventions, tests and build setup.
- You cannot edit files. Your shell is limited to read-only commands: ${SHELL_COMMANDS_TEXT}.
  Run one command per Bash call. Chained commands (&&, ;, |) and anything else are denied.
  Use the Grep and Glob tools to search, not shell commands.
- When a decision belongs to the user (scope, product behavior, a trade-off you cannot settle from the code),
  call ask_human. Ask one focused question at a time and offer choices when you can.
  Then end your turn. The answer arrives as the next user message.
- Do not ask about things you can find out from the repository.
- When you learn something about the project that every later task would want to know and that is hard to see from the code
  (the real build or test command, where something lives, a trap you hit), suggest it with remember. One short fact per call.
  Skip anything obvious, anything specific to this task, and anything already in Project memory.
- When you know enough, call submit_plan. Acceptance criteria must be concrete and checkable.
  List every decision you made without asking under assumptions, so the user can review them.
  Give the plan a headline: one plain sentence saying what it does and the one thing to check. The board shows it first.
- When the work is really two or more separate changes, each of which makes sense as its own pull request
  (a backend change and the screen that uses it, or a refactor and the feature on top), fill in subtasks.
  Each subtask has a title and the positions of its steps, counting from 0. Every step belongs to exactly one subtask.
  Set dependsOn to the positions of earlier subtasks that must be merged first. Leave it empty for ones that stand
  alone, since those run side by side. Leave subtasks out for work that fits one change. Do not split to look thorough.
- After submit_plan succeeds, end your turn with a short summary of the plan.

The user may chat with you later, including after the plan is approved. Answer their questions.
If they ask for changes while the plan is still under review, submit a revised plan with submit_plan.
`.trim();

export function researcherBrief(task: Task, project: Project, rules: string[] = [], memory: string[] = []): string {
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
    `Repository: ${project.repoPath} (base branch ${project.baseBranch})`,
    commands.length > 0 ? `Project commands: ${commands.join(", ")}` : "Project commands: none configured.",
    "",
    importedNote(task),
    rulesNote(rules),
    memoryNote(memory),
    "Research this task and submit a plan with submit_plan. Use ask_human if something is unclear.",
  ].join("\n");
}
