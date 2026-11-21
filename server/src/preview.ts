import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Project } from "@dot/shared";
import { killTree, plainEnv } from "./checks.ts";
import { asAgent, handOver, isolated } from "./isolation.ts";

// Starts a task's dev server in its worktree, opens the page in a headless browser and takes a picture,
// so you can judge a change by looking at it. The dev server runs code from the task branch, and so does
// the page, so both get what agents get: the agent user when isolation is on, and an environment without
// Dot's settings or any Claude or API credentials.

export type PreviewResult = { ok: true; png: Buffer; note: string } | { ok: false; error: string };

const START_TIMEOUT_MS = 90_000;
const SHOT_TIMEOUT_MS = 60_000;

// The address must be on this machine. A preview that could open any site would screenshot the open internet.
export function previewUrl(devUrl: string | null): URL | null {
  if (!devUrl) return null;
  try {
    const url = new URL(devUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    return (url.protocol === "http:" || url.protocol === "https:") && local ? url : null;
  } catch {
    return null;
  }
}

// Chrome, Chromium or Edge, whichever is installed. DOT_BROWSER_BIN names one explicitly.
export function findBrowser(env = process.env): string | null {
  const given = env.DOT_BROWSER_BIN?.trim();
  if (given) return existsSync(given) ? given : null;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const root of roots) {
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
        join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"]) {
      candidates.push(join(dir, name));
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

// True once something answers on the address, whatever the status code.
async function answers(url: URL): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runBrowser(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const [command, wrapped] = asAgent(bin, args);
    const child = spawn(command, wrapped, { env: plainEnv(), windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => killTree(child), timeoutMs);
    const stop = () => killTree(child);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ ok: code === 0, output });
    });
  });
}

export async function capturePreview(project: Project, cwd: string, signal?: AbortSignal): Promise<PreviewResult> {
  const url = previewUrl(project.devUrl);
  if (!project.devCommand || !url) {
    return { ok: false, error: "Set a dev command and a dev URL on this machine, such as http://localhost:5173, in the project settings." };
  }
  const bin = findBrowser();
  if (!bin) {
    return { ok: false, error: "Dot found no Chrome, Chromium or Edge to take the picture. Install one, or set DOT_BROWSER_BIN to its path." };
  }
  if (await answers(url)) {
    return { ok: false, error: `Something already answers at ${url.href}, so the preview would show that and not this branch. Stop it and try again.` };
  }

  // The dev server leads its own process group on POSIX, so killing it reaches everything it started.
  const [command, args] = asAgent("sh", ["-c", project.devCommand]);
  const options = { cwd, env: plainEnv(), windowsHide: true, detached: process.platform !== "win32" };
  const server = command === "sh" ? spawn(project.devCommand, { ...options, shell: true }) : spawn(command, args, options);
  let log = "";
  let exited = false;
  const take = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-4000);
  };
  server.stdout?.on("data", take);
  server.stderr?.on("data", take);
  server.on("close", () => {
    exited = true;
  });
  server.on("error", (err) => {
    log += `\n${err.message}`;
    exited = true;
  });

  const scratch = mkdtempSync(join(tmpdir(), "dot-preview-"));
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await answers(url))) {
      if (signal?.aborted) return { ok: false, error: "Stopped." };
      if (exited) return { ok: false, error: `The dev server exited before it answered at ${url.href}.\n\n${log.trim()}` };
      if (Date.now() > deadline) {
        return { ok: false, error: `The dev server did not answer at ${url.href} within ${START_TIMEOUT_MS / 1000} seconds.\n\n${log.trim()}` };
      }
      await sleep(500);
    }
    // Give a dev server that answers early a moment to finish its first build.
    await sleep(1500);

    handOver(scratch);
    const file = join(scratch, "shot.png");
    const shot = await runBrowser(
      bin,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(scratch, "profile")}`,
        // Chrome's own sandbox cannot start as root. The agent user takes its place in the image.
        ...(isolated || process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        "--window-size=1280,900",
        "--virtual-time-budget=8000",
        `--screenshot=${file}`,
        url.href,
      ],
      SHOT_TIMEOUT_MS,
      signal,
    );
    if (signal?.aborted) return { ok: false, error: "Stopped." };
    if (!existsSync(file)) {
      return { ok: false, error: `The browser did not produce a picture.\n\n${shot.output.trim() || "(no output)"}` };
    }
    return { ok: true, png: readFileSync(file), note: `Preview of ${url.href} from this branch, 1280 pixels wide.` };
  } finally {
    killTree(server);
    // killTree ends the process tree asynchronously. Give it a moment so a caller that waits for this
    // function can then remove the worktree.
    await sleep(750);
    rmSync(scratch, { recursive: true, force: true });
  }
}
