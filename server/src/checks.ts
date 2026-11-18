import { spawn } from "node:child_process";
import type { Project } from "@dot/shared";
import { asAgent } from "./isolation.ts";

// Runs the project's own test, lint and typecheck commands in a task's worktree, so the reviewer starts
// from known results. The commands run code from the task branch, so they get what agents get: the agent
// user when isolation is on, and an environment without Dot's own settings or any Claude or API credentials.

export type CheckResult = {
  name: "test" | "lint" | "typecheck";
  command: string;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  // The end of the combined output, where the failure usually is.
  output: string;
  seconds: number;
};

const OUTPUT_LIMIT = 6000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function checkCommands(project: Project): { name: CheckResult["name"]; command: string }[] {
  const all = [
    { name: "test", command: project.testCommand },
    { name: "lint", command: project.lintCommand },
    { name: "typecheck", command: project.typecheckCommand },
  ] as const;
  return all.flatMap((c) => (c.command ? [{ name: c.name, command: c.command }] : []));
}

function plainEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC_|DOT_)/.test(key)));
}

function runOne(name: CheckResult["name"], command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const [bin, args] = asAgent("sh", ["-c", command]);
    // Without isolation the command runs through the platform's own shell, as an agent's Bash tool would.
    const child =
      bin === "sh" ? spawn(command, { cwd, env: plainEnv(), shell: true, windowsHide: true }) : spawn(bin, args, { cwd, env: plainEnv(), windowsHide: true });
    let output = "";
    let timedOut = false;
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT * 2);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        name,
        command,
        ok: exitCode === 0 && !timedOut,
        timedOut,
        exitCode,
        output: output.slice(-OUTPUT_LIMIT).trim(),
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// One after another, so two commands never fight over the same files.
export async function runChecks(project: Project, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, command } of checkCommands(project)) results.push(await runOne(name, command, cwd, timeoutMs));
  return results;
}

export function checksSummary(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const state = r.timedOut ? "timed out" : r.ok ? "passed" : `failed (exit ${r.exitCode ?? "none"})`;
    return `- ${r.name}: ${state} in ${r.seconds}s, \`${r.command}\``;
  });
  const failed = results.filter((r) => !r.ok);
  const details = failed.map((r) => `\n${r.name} output, last lines:\n\n\`\`\`\n${r.output || "(no output)"}\n\`\`\``);
  return [...lines, ...details].join("\n");
}
