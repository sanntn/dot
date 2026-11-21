import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve, sep } from "node:path";
import { previewPathProblem, type Project } from "@dot/shared";
import { killTree, plainEnv } from "./checks.ts";
import { asAgent, handOver, isolated } from "./isolation.ts";

// Starts a task's dev server in its worktree, opens the page in a headless browser and takes a picture,
// so you can judge a change by looking at it. The dev server runs code from the task branch, and so does
// the page, so both get what agents get: the agent user when isolation is on, and an environment without
// Dot's settings or any Claude or API credentials.

export type PreviewResult = { ok: true; png: Buffer; note: string } | { ok: false; error: string };

const START_TIMEOUT_MS = 90_000;
const SHOT_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 180_000;

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

// How a project previews: a dev server it starts, or a static page Dot serves from the worktree.
export function previewMode(project: Project): "server" | "page" | null {
  if (project.devCommand && previewUrl(project.devUrl)) return "server";
  if (project.previewPath && previewPathProblem(project.previewPath) === null) return "page";
  return null;
}

export const PREVIEW_SETUP_HINT =
  "Set a dev command and a dev URL on this machine, such as http://localhost:5173, or a preview page such as .dot-preview/index.html, in the project settings.";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

// Serves a folder over HTTP on a free loopback port. Anything that resolves outside the folder, symlinks
// included, gets a 404.
export function serveFolder(root: string): Promise<{ url: URL; close: () => void }> {
  const base = realpathSync(root);
  const server = createServer((req, res) => {
    const deny = () => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    };
    if (req.method !== "GET" && req.method !== "HEAD") return deny();
    try {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      let file = resolve(base, `.${path}`);
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      file = realpathSync(file);
      if (file !== base && !file.startsWith(base + sep)) return deny();
      res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch {
      deny();
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("The preview server has no port"));
      resolveServer({ url: new URL(`http://127.0.0.1:${address.port}/`), close: () => server.close() });
    });
  });
}

// Runs the build command in the worktree, as the agent user when isolation is on.
function runBuild(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveBuild) => {
    const [bin, args] = asAgent("sh", ["-c", command]);
    const options = { cwd, env: plainEnv(), windowsHide: true, detached: process.platform !== "win32" };
    const child = bin === "sh" ? spawn(command, { ...options, shell: true }) : spawn(bin, args, options);
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
      resolveBuild({ ok: false, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolveBuild({ ok: code === 0, output });
    });
  });
}

// Takes the picture of a page that is already answering.
async function shoot(bin: string, url: URL, signal?: AbortSignal): Promise<PreviewResult> {
  const scratch = mkdtempSync(join(tmpdir(), "dot-preview-"));
  try {
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
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Builds the worktree, serves it and shoots the project's preview page.
async function capturePage(project: Project, cwd: string, bin: string, signal?: AbortSignal): Promise<PreviewResult> {
  const page = project.previewPath!;
  if (project.previewBuild) {
    const built = await runBuild(project.previewBuild, cwd, BUILD_TIMEOUT_MS, signal);
    if (signal?.aborted) return { ok: false, error: "Stopped." };
    if (!built.ok) return { ok: false, error: `The build command failed.\n\n${built.output.trim() || "(no output)"}` };
  }
  const file = resolve(cwd, page);
  if (!existsSync(file)) {
    return { ok: false, error: `This branch has no ${page}. Ask the agent to write that page, then try again.` };
  }
  const site = await serveFolder(cwd);
  try {
    const url = new URL(page.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/"), site.url);
    const result = await shoot(bin, url, signal);
    return result.ok ? { ...result, note: `Preview of ${page} from this branch, 1280 pixels wide.` } : result;
  } finally {
    site.close();
  }
}

export async function capturePreview(project: Project, cwd: string, signal?: AbortSignal): Promise<PreviewResult> {
  const mode = previewMode(project);
  if (!mode) return { ok: false, error: PREVIEW_SETUP_HINT };
  const bin = findBrowser();
  if (!bin) {
    return { ok: false, error: "Dot found no Chrome, Chromium or Edge to take the picture. Install one, or set DOT_BROWSER_BIN to its path." };
  }
  if (mode === "page") return capturePage(project, cwd, bin, signal);
  return captureDevServer(project, cwd, bin, signal);
}

async function captureDevServer(project: Project, cwd: string, bin: string, signal?: AbortSignal): Promise<PreviewResult> {
  const url = previewUrl(project.devUrl)!;
  if (await answers(url)) {
    return { ok: false, error: `Something already answers at ${url.href}, so the preview would show that and not this branch. Stop it and try again.` };
  }

  // The dev server leads its own process group on POSIX, so killing it reaches everything it started.
  const devCommand = project.devCommand!;
  const [command, args] = asAgent("sh", ["-c", devCommand]);
  const options = { cwd, env: plainEnv(), windowsHide: true, detached: process.platform !== "win32" };
  const server = command === "sh" ? spawn(devCommand, { ...options, shell: true }) : spawn(command, args, options);
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
    return await shoot(bin, url, signal);
  } finally {
    killTree(server);
    // killTree ends the process tree asynchronously. Give it a moment so a caller that waits for this
    // function can then remove the worktree.
    await sleep(750);
  }
}
