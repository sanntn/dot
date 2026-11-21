import { spawn, type ChildProcess } from "node:child_process";
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

export function plainEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC_|DOT_)/.test(key)));
}

// Kills the command and everything it started. Killing only the shell would leave the real command
// running with the output pipes open.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

// Colour codes from test runners are noise in a prompt.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

// How long to wait for the output pipes to close after the kill, before giving up on them.
const KILL_GRACE_MS = 1000;

function runOne(
  name: CheckResult["name"],
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const [bin, args] = asAgent("sh", ["-c", command]);
    // Without isolation the command runs through the platform's own shell, as an agent's Bash tool would.
    // On POSIX it leads its own process group, so the kill reaches everything it started.
    const options = { cwd, env: plainEnv(), windowsHide: true, detached: process.platform !== "win32" };
    const child = bin === "sh" ? spawn(command, { ...options, shell: true }) : spawn(bin, args, options);
    let output = "";
    let timedOut = false;
    let done = false;
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT * 2);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);

    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({
        name,
        command,
        ok: exitCode === 0 && !timedOut,
        timedOut,
        exitCode,
        output: output.replace(ANSI, "").slice(-OUTPUT_LIMIT).trim(),
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
    };
    const stop = () => {
      killTree(child);
      setTimeout(() => finish(null), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });

    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// One after another, so two commands never fight over the same files. An aborted run stops at once.
export async function runChecks(
  project: Project,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, command } of checkCommands(project)) {
    if (signal?.aborted) break;
    results.push(await runOne(name, command, cwd, timeoutMs, signal));
  }
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
