import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ClaudeAccount } from "@dot/shared";
import { createInterface } from "node:readline";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAgent, handOver } from "../isolation.ts";

// Runs one `claude -p` process in stream-json mode. The process stays alive between turns,
// so chat messages can go straight into a running session. Dot ends stdin once a turn finishes
// and nothing new arrives within a short grace period, and the process then exits.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type StreamEvent = { type: string; subtype?: string; [key: string]: unknown };

export type LaunchOptions = {
  cwd: string;
  sessionId: string;
  resume: boolean;
  model: string;
  appendSystemPrompt: string;
  tools: string[];
  allowedTools: string[];
  deniedTools: string[];
  mcpUrl: string;
  // CLAUDE_CONFIG_DIR for this launch, to use a project's own login. Null keeps Dot's own.
  configDir: string | null;
  // The name of a DOT_CLAUDE_TOKEN_<NAME> variable to run as. Null uses the default login.
  tokenName: string | null;
};

export type ProcessHandlers = {
  onEvent: (event: StreamEvent) => void;
  // Called when a turn ends. Anything sent from inside this callback starts the next turn.
  onTurnEnd: (result: StreamEvent) => void;
  onExit: (info: { code: number | null; stderr: string; sawResult: boolean }) => void;
};

const GRACE_MS = 1500;
const STDERR_LIMIT = 8000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_URL_WAIT_MS = 15_000;

// Dot must run the CLI as you, on your subscription. Strip API keys so a key in the
// environment can't switch billing to the API, and strip variables a parent Claude
// session sets, so a Dot started from inside Claude Code behaves the same as from a terminal.
// CLAUDE_CONFIG_DIR stays, since it says where your login lives, unless a project names its own.
// DOT_* goes too: Dot's own settings include the Bitbucket and GitHub tokens, which no agent may see.
// Named subscription tokens, one per account, from `claude setup-token`. They live in the server's
// environment as DOT_CLAUDE_TOKEN_<NAME>, so no secret is stored in the database. Names are upper case.
const TOKEN_PREFIX = "DOT_CLAUDE_TOKEN_";

// Claude Code's own sandbox settings for every agent, set once at startup (DOT_AGENT_SANDBOX=on). Null leaves it off.
let sandbox: object | null = null;
export function setSandbox(settings: object | null): void {
  sandbox = settings;
}
export const isTokenName = (name: string) => /^[A-Z0-9_]+$/.test(name);

export function claudeTokenFor(name: string): string | null {
  return isTokenName(name) ? process.env[`${TOKEN_PREFIX}${name}`]?.trim() || null : null;
}

export function claudeTokens(): { names: string[]; hasDefault: boolean } {
  const names = Object.keys(process.env)
    .filter((key) => key.startsWith(TOKEN_PREFIX) && process.env[key]?.trim())
    .map((key) => key.slice(TOKEN_PREFIX.length))
    .filter(isTokenName)
    .sort();
  return { names, hasDefault: Boolean(process.env.DOT_CLAUDE_TOKEN?.trim()) };
}

function cleanEnv(configDir: string | null, tokenName: string | null = null): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key === "CLAUDE_CONFIG_DIR" || !/^(CLAUDE|ANTHROPIC_|DOT_)/.test(key),
    ),
  );
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  // A deployed Dot has no browser to sign in with, so it runs on long-lived subscription tokens.
  // A project's named token wins. Without one, a project with its own config folder keeps that
  // folder's login, and everything else uses DOT_CLAUDE_TOKEN.
  const named = tokenName ? claudeTokenFor(tokenName) : null;
  const fallback = !configDir ? process.env.DOT_CLAUDE_TOKEN?.trim() : undefined;
  const token = named ?? fallback;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

// Asks the CLI which account a config folder is logged into.
export function claudeAccount(configDir: string | null, tokenName: string | null = null): Promise<ClaudeAccount> {
  return new Promise((resolve, reject) => {
    const [command, args] = asAgent(...claudeCommand(["auth", "status", "--json"]));
    execFile(
      command,
      args,
      { env: cleanEnv(configDir, tokenName), windowsHide: true, timeout: 30_000 },
      (err, stdout) => {
        // auth status exits nonzero when logged out, but still prints the JSON.
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          return reject(err ?? new Error("The claude CLI gave no auth status"));
        }
        const text = (v: unknown) => (typeof v === "string" && v ? v : null);
        resolve({
          loggedIn: data.loggedIn === true,
          email: text(data.email),
          orgName: text(data.orgName),
          subscriptionType: text(data.subscriptionType),
          configDirectory: text(data.configDirectory),
        });
      },
    );
  });
}

type LoginState = { running: boolean; error: string | null; url: string | null; child: ChildProcess };
const logins = new Map<string, LoginState>();

// Whether a sign-in for this folder is still waiting, and why the last one failed.
export function claudeLoginStatus(configDir: string): { running: boolean; error: string | null } {
  const state = logins.get(configDir);
  return { running: state?.running ?? false, error: state?.error ?? null };
}

// Starts `claude auth login` for a config folder and returns the sign-in link, so the web page
// can open it in the browser you are already using. The CLI would open the machine's default
// browser instead. Its BROWSER variable names the program it runs to open a link, so Dot points
// that at a tiny script that saves the link to a file. The CLI keeps waiting for the sign-in
// in the background and exits once the browser calls back to it on localhost.
export function startClaudeLogin(configDir: string): Promise<string> {
  const existing = logins.get(configDir);
  if (existing?.running && existing.url) return Promise.resolve(existing.url);
  existing?.child.kill();

  const tmp = mkdtempSync(join(tmpdir(), "dot-login-"));
  handOver(tmp);
  const urlFile = join(tmp, "url.txt");
  const windows = process.platform === "win32";
  const script = join(tmp, windows ? "open.cmd" : "open.sh");
  writeFileSync(script, windows ? `@echo %1> "${urlFile}"\r\n` : `#!/bin/sh\nprintf '%s' "$1" > "${urlFile}"\n`);
  if (!windows) chmodSync(script, 0o755);

  const [loginCommand, loginArgs] = asAgent(...claudeCommand(["auth", "login"]));
  const child = spawn(loginCommand, loginArgs, {
    env: { ...cleanEnv(configDir), BROWSER: script },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state: LoginState = { running: true, error: null, url: null, child };
  logins.set(configDir, state);

  let stderr = "";
  let timedOut = false;
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, LOGIN_TIMEOUT_MS);
  child.on("error", (err) => {
    state.error = err.message;
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    state.running = false;
    if (code !== 0 && !state.error) {
      state.error = timedOut ? "The sign-in timed out" : stderr.trim() || "The sign-in did not finish";
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      let url = "";
      try {
        url = readFileSync(urlFile, "utf8").replace(/["\s]/g, "");
      } catch {
        // The CLI has not asked to open a link yet.
      }
      if (/^https:\/\//.test(url)) {
        clearInterval(poll);
        state.url = url;
        resolve(url);
      } else if (!state.running) {
        clearInterval(poll);
        reject(new Error(state.error ?? "The claude CLI exited before it gave a sign-in link"));
      } else if (Date.now() - started > LOGIN_URL_WAIT_MS) {
        clearInterval(poll);
        child.kill();
        reject(new Error("The claude CLI did not give a sign-in link"));
      }
    }, 100);
  });
}

export function claudeBinary(): string {
  return process.env.DOT_CLAUDE_BIN || "claude";
}

// The command that runs the CLI with these arguments. A .js or .mjs path runs under Node, which is
// how the tests point DOT_CLAUDE_BIN at a scripted stand-in on every platform.
export function claudeCommand(args: string[]): [string, string[]] {
  const bin = claudeBinary();
  return /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

export class ClaudeProcess {
  private readonly child: ChildProcess;
  private stdinClosed = false;
  private graceTimer: NodeJS.Timeout | undefined;
  private wroteDuringTurnEnd = false;
  private inTurnEnd = false;
  private stderr = "";
  private sawResult = false;

  constructor(options: LaunchOptions, private readonly handlers: ProcessHandlers) {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--model",
      options.model,
      // Ignore user, project and local settings so their allow rules can't widen what the agent may do.
      "--restricted",
      // --settings still applies under --restricted. Empty attribution keeps the
      // "Co-Authored-By: Claude" line out of the agents' commits and pull requests.
      "--settings",
      JSON.stringify({ attribution: { commit: "", pr: "" }, ...(sandbox ? { sandbox } : {}) }),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { dot: { type: "http", url: options.mcpUrl } } }),
      "--tools",
      options.tools.join(","),
      // One argv entry per rule, so rules with spaces can't be split apart.
      "--allowedTools",
      ...options.allowedTools,
      ...(options.deniedTools.length > 0 ? ["--disallowedTools", ...options.deniedTools] : []),
      // Nobody answers permission prompts. Anything not allowed above is denied.
      "--permission-prompts",
      "none",
      "--append-system-prompt",
      options.appendSystemPrompt,
      ...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
    ];

    const [command, wrapped] = asAgent(...claudeCommand(args));
    this.child = spawn(command, wrapped, {
      cwd: options.cwd,
      env: cleanEnv(options.configDir, options.tokenName),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT);
    });
    this.child.on("error", (err) => {
      this.stderr += `\n${err.message}`;
      // If the process never started (claude not found, or a .cmd shim Node can't run directly),
      // "close" may never fire. Report the exit here so the run doesn't stay "Working" forever.
      if (this.child.pid === undefined) {
        const hint =
          "Could not start the claude CLI. Check that it is installed and on PATH, or set DOT_CLAUDE_BIN to the claude executable.";
        this.stderr = `${hint}\n${this.stderr.trim()}`;
        this.finish(null);
      }
    });
    this.child.on("close", (code) => this.finish(code));
    this.child.stdin!.on("error", () => {
      // The process died with input pending. The close handler reports it.
    });
  }

  private exited = false;

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.graceTimer);
    this.stdinClosed = true;
    this.handlers.onExit({ code, stderr: this.stderr.trim(), sawResult: this.sawResult });
  }

  get acceptingInput(): boolean {
    return !this.stdinClosed;
  }

  send(content: ContentBlock[]): void {
    if (this.stdinClosed) throw new Error("Agent process is no longer accepting input");
    clearTimeout(this.graceTimer);
    if (this.inTurnEnd) this.wroteDuringTurnEnd = true;
    if (this.child.stdin!.destroyed) return;
    this.child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  }

  endInput(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    clearTimeout(this.graceTimer);
    if (!this.child.stdin!.destroyed) this.child.stdin!.end();
  }

  kill(): void {
    this.endInput();
    this.child.kill();
  }

  private onLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }

    // A new turn started (a queued message is being handled), so don't close input.
    if (event.type === "assistant" || (event.type === "system" && event.subtype === "init")) {
      clearTimeout(this.graceTimer);
    }

    this.handlers.onEvent(event);

    if (event.type === "result") {
      this.sawResult = true;
      this.inTurnEnd = true;
      this.wroteDuringTurnEnd = false;
      try {
        this.handlers.onTurnEnd(event);
      } finally {
        this.inTurnEnd = false;
      }
      if (!this.wroteDuringTurnEnd && !this.stdinClosed) {
        this.graceTimer = setTimeout(() => this.endInput(), GRACE_MS);
      }
    }
  }
}

// A short, human-readable line for a tool call, for the activity log. Paths inside the repo show relative to it.
export function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
  const pick = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  // The repo path can appear as D:\x, D:/x, or Git Bash style /d/x. Only those path prefixes are
  // rewritten, so backslashes elsewhere (printf 'hi\n') stay as the agent wrote them.
  const root = cwd.replace(/[\\/]+$/, "");
  const forward = root.replace(/\\/g, "/");
  const roots = [root, forward, root.replace(/\//g, "\\")];
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive) roots.push(`/${drive[1]!.toLowerCase()}/${forward.slice(3)}`);

  let detail = pick("file_path", "path", "pattern", "command", "url", "query", "description") ?? "";
  for (const r of new Set(roots)) {
    detail = detail.split(`${r}/`).join("").split(`${r}\\`).join("").split(r).join(".");
  }
  const short = detail.length > 160 ? `${detail.slice(0, 157)}...` : detail;
  return short ? `${name}: ${short}` : name;
}
