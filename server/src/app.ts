import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ClaudeAccountQuerySchema,
  RemoteQuerySchema,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MergeSchema,
  PlanUpdateSchema,
  ProjectInputSchema,
  ProjectPatchSchema,
  SendBackSchema,
  SendMessageSchema,
  TaskInputSchema,
  TaskMoveSchema,
  TaskPatchSchema,
} from "@dot/shared";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { EventBus } from "./events.ts";
import { claudeAccount, claudeLoginStatus, startClaudeLogin } from "./agents/claude.ts";
import type { Auth } from "./auth.ts";
import { HttpError, notFound } from "./errors.ts";
import { branchDiff, branchExistsLocally, cloneRepo, gitError, resolveBaseRef } from "./git.ts";
import { GitHub } from "./github.ts";
import { detectRemote } from "./githost.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { Store } from "./store.ts";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const hostnameOf = (host: string) => host.toLowerCase().replace(/:\d+$/, "");

// Dot listens on loopback, but any web page you open can still send requests to it.
// Reject requests addressed to a non-loopback host name (DNS rebinding) and requests
// that come from another site (cross-site request forgery). The claude CLI sends
// neither Origin nor Sec-Fetch-Site, so agent calls to /api/mcp pass.
// `extraHosts` are the public host names of a deployed Dot (DOT_ALLOWED_HOSTS).
function requestGuard(c: Context, extraHosts: Set<string>): string | null {
  const allowed = (hostname: string) =>
    LOOPBACK_HOSTS.has(hostname) || LOOPBACK_HOSTS.has(`[${hostname}]`) || extraHosts.has(hostname);
  const host = hostnameOf(c.req.header("host") ?? "");
  if (!allowed(host)) {
    return extraHosts.size
      ? `Requests must be addressed to localhost or a host in DOT_ALLOWED_HOSTS, not ${host}`
      : `Requests must be addressed to localhost. To serve Dot on ${host}, add it to DOT_ALLOWED_HOSTS.`;
  }

  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-site requests are not allowed";

  const origin = c.req.header("origin");
  if (origin) {
    let hostname = "";
    try {
      hostname = new URL(origin).hostname;
    } catch {
      // Malformed or "null" origin. Treat as foreign.
    }
    if (!allowed(hostname)) return "Cross-site requests are not allowed";
  }
  return null;
}

async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  // A JSON content type can't be sent cross-site without a CORS preflight, which Dot never approves.
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Request body must be sent as application/json");
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

function idParam(c: Context, name = "id"): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Not found");
  return id;
}

// A worktree has a .git file and a normal clone has a .git directory. Both pass.
function checkRepoPath(path: string): string {
  const full = resolve(path);
  if (!existsSync(join(full, ".git"))) throw new HttpError(400, `Not a git repository: ${full}`);
  return full;
}

// A Claude config folder must be an absolute path, so it means the same thing wherever an agent runs.
// A leading ~ means your home folder. Blank means the default login.
function checkConfigDir(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const expanded = /^~(?=$|[\\/])/.test(trimmed) ? join(homedir(), trimmed.slice(1)) : trimmed;
  if (!isAbsolute(expanded)) throw new HttpError(400, `The Claude config folder must be a full path: ${trimmed}`);
  return resolve(expanded);
}

export function createApp(
  store: Store,
  bus: EventBus,
  orchestrator: Orchestrator,
  options: { attachmentsDir: string; reposDir: string; auth: Auth; allowedHosts?: string[] },
) {
  const extraHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const app = new Hono().basePath("/api");

  // Database rows go with their task through ON DELETE CASCADE. The image files on disk need removing by hand.
  const removeAttachments = (taskId: number) => {
    try {
      rmSync(join(options.attachmentsDir, String(taskId)), { recursive: true, force: true });
    } catch (err) {
      console.error(`Could not remove attachments for task ${taskId}:`, err);
    }
  };

  app.use("*", async (c, next) => {
    const problem = requestGuard(c, extraHosts);
    if (problem) return c.json({ error: problem }, 403);
    await next();
  });
  app.use("*", options.auth.middleware);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Whether this Dot asks for a password, and whether this browser has signed in.
  app.get("/session", (c) => c.json({ authRequired: options.auth.enabled, signedIn: options.auth.isSignedIn(c) }));

  app.post("/login", async (c) => {
    const { password } = await parseBody(c, z.object({ password: z.string().max(500) }));
    const problem = options.auth.signIn(c, password);
    if (problem) throw new HttpError(401, problem);
    return c.json({ authRequired: true, signedIn: true });
  });

  app.post("/logout", (c) => {
    options.auth.signOut(c);
    return c.body(null, 204);
  });

  app.get("/projects", (c) => c.json(store.listProjects()));

  app.post("/projects", async (c) => {
    const { githubRepo, ...data } = await parseBody(c, ProjectInputSchema);
    let repoPath: string;
    let { baseBranch, repoHost, repoOwner, repoName } = data;
    if (githubRepo) {
      // Dot clones it into its own repos folder, once. Later tasks fetch from origin as usual.
      const [owner, name] = githubRepo.split("/") as [string, string];
      repoPath = join(options.reposDir, `${owner}__${name}`);
      if (!existsSync(join(repoPath, ".git"))) {
        try {
          const checkedOut = await cloneRepo(`https://github.com/${owner}/${name}.git`, repoPath);
          if (!(await branchExistsLocally(repoPath, baseBranch)) && checkedOut) baseBranch = checkedOut;
        } catch (err) {
          throw new HttpError(
            502,
            `Could not clone ${githubRepo}: ${gitError(err)}
A deployed Dot needs DOT_GITHUB_TOKEN with Contents access to the repository.`,
          );
        }
      }
      repoHost ??= "github";
      repoOwner ??= owner;
      repoName ??= name;
    } else {
      repoPath = checkRepoPath(data.repoPath!);
    }
    const project = store.createProject({
      ...data,
      repoPath,
      baseBranch,
      repoHost,
      repoOwner,
      repoName,
      claudeConfigDir: checkConfigDir(data.claudeConfigDir),
    });
    bus.publish({ type: "projects.changed" });
    return c.json(project, 201);
  });

  app.patch("/projects/:id", async (c) => {
    const patch = await parseBody(c, ProjectPatchSchema);
    if (patch.repoPath !== undefined) patch.repoPath = checkRepoPath(patch.repoPath);
    if (patch.claudeConfigDir !== undefined) patch.claudeConfigDir = checkConfigDir(patch.claudeConfigDir);
    const project = store.updateProject(idParam(c), patch);
    bus.publish({ type: "projects.changed" });
    return c.json(project);
  });

  app.delete("/projects/:id", async (c) => {
    const id = idParam(c);
    const tasks = store.listTasks(id);
    // Stop first and wait for exit, so no agent holds its worktree folder while it is removed.
    await Promise.all(tasks.map((task) => orchestrator.stop(task.id)));
    for (const task of tasks) await orchestrator.cleanupWorkspace(task.id);
    store.deleteProject(id);
    for (const task of tasks) removeAttachments(task.id);
    bus.publish({ type: "projects.changed" });
    return c.body(null, 204);
  });

  // Repositories the GitHub token can push to, for the new-project picker. Empty without a token.
  app.get("/github/repos", async (c) => {
    const api = GitHub.fromEnv();
    if (!api) return c.json({ configured: false, repos: [] });
    try {
      return c.json({ configured: true, repos: await api.listRepos() });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  });

  // Which account a config folder is logged into, for the project settings. POST keeps the path out of URLs.
  app.post("/claude-account", async (c) => {
    const { configDir } = await parseBody(c, ClaudeAccountQuerySchema);
    const dir = checkConfigDir(configDir);
    // The CLI creates the folder just by checking it, so don't ask about one that isn't there yet.
    if (dir && !existsSync(dir)) {
      return c.json({ loggedIn: false, email: null, orgName: null, subscriptionType: null, configDirectory: dir });
    }
    try {
      return c.json(await claudeAccount(dir));
    } catch (err) {
      throw new HttpError(502, `Could not ask the claude CLI: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Starts a Claude sign-in for a config folder and returns the link, which the web page opens in its own
  // browser. The sign-in then finishes in the background when the browser calls back to the CLI.
  app.post("/claude-login", async (c) => {
    const { configDir } = await parseBody(c, ClaudeAccountQuerySchema);
    const dir = checkConfigDir(configDir);
    if (!dir) throw new HttpError(400, "Enter a Claude config folder first");
    try {
      return c.json({ url: await startClaudeLogin(dir) });
    } catch (err) {
      throw new HttpError(502, `Could not sign in: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Whether that sign-in is still waiting, for the page to poll.
  app.post("/claude-login-status", async (c) => {
    const { configDir } = await parseBody(c, ClaudeAccountQuerySchema);
    const dir = checkConfigDir(configDir);
    if (!dir) throw new HttpError(400, "Enter a Claude config folder first");
    return c.json(claudeLoginStatus(dir));
  });

  // What the repository's origin remote says about its host, owner and repo, for the project settings.
  // POST keeps the path out of URLs.
  app.post("/repo-remote", async (c) => {
    const { repoPath } = await parseBody(c, RemoteQuerySchema);
    return c.json(await detectRemote(checkRepoPath(repoPath)));
  });

  app.get("/projects/:id/tasks", (c) => c.json(store.listTasks(idParam(c))));

  app.post("/tasks", async (c) => {
    const task = store.createTask(await parseBody(c, TaskInputSchema));
    bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    return c.json(task, 201);
  });

  app.patch("/tasks/:id", async (c) => {
    const task = store.updateTask(idParam(c), await parseBody(c, TaskPatchSchema));
    bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    return c.json(task);
  });

  app.post("/tasks/:id/move", async (c) => {
    const task = store.moveTask(idParam(c), await parseBody(c, TaskMoveSchema));
    bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    return c.json(task);
  });

  app.delete("/tasks/:id", async (c) => {
    const id = idParam(c);
    await orchestrator.stop(id);
    await orchestrator.cleanupWorkspace(id);
    const task = store.deleteTask(id);
    removeAttachments(id);
    bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    return c.body(null, 204);
  });

  // Agents

  // Starts, resumes or retries the agent for the task's current column.
  app.post("/tasks/:id/start", async (c) => {
    const task = store.getTask(idParam(c));
    if (task.column === "inbox") return c.json(orchestrator.startResearch(task.id));
    if (task.column === "research") return c.json(orchestrator.resumeResearch(task.id));
    if (task.column === "execute") return c.json(await orchestrator.startExecution(task.id));
    if (task.column === "review") return c.json(await orchestrator.startReview(task.id));
    throw new HttpError(409, "There is no agent to start for this column");
  });

  app.get("/tasks/:id/review", (c) => {
    const id = idParam(c);
    store.getTask(id);
    return c.json(store.latestReview(id));
  });

  app.post("/tasks/:id/review/approve", async (c) => c.json(await orchestrator.approveReview(idParam(c))));

  // Approves the merge from Merge approval, or retries it from Merge.
  app.post("/tasks/:id/merge", async (c) => {
    const { skipCi } = await parseBody(c, MergeSchema);
    return c.json(await orchestrator.startMerge(idParam(c), { skipCi }));
  });

  app.post("/tasks/:id/review/request-changes", async (c) => {
    const { notes } = await parseBody(c, SendBackSchema);
    return c.json(await orchestrator.requestChanges(idParam(c), notes));
  });

  app.get("/tasks/:id/report", (c) => {
    const id = idParam(c);
    store.getTask(id);
    return c.json(store.latestExecutionReport(id));
  });

  // The task branch's committed changes against the project's base branch. Null before execution starts.
  app.get("/tasks/:id/diff", async (c) => {
    const task = store.getTask(idParam(c));
    if (!task.branch || !task.worktreePath || !existsSync(task.worktreePath)) return c.json(null);
    const project = store.getProject(task.projectId);
    try {
      const baseRef = await resolveBaseRef(project.repoPath, project.baseBranch);
      return c.json(await branchDiff(task.worktreePath, baseRef, task.branch, project.baseBranch));
    } catch (err) {
      throw new HttpError(409, `Could not read the diff: ${gitError(err)}`);
    }
  });

  app.post("/tasks/:id/stop", async (c) => {
    await orchestrator.stop(idParam(c));
    return c.body(null, 204);
  });

  app.get("/tasks/:id/runs", (c) => {
    const id = idParam(c);
    store.getTask(id);
    return c.json(orchestrator.runsFor(id));
  });

  app.get("/tasks/:id/messages", (c) => {
    const id = idParam(c);
    store.getTask(id);
    const after = Number(c.req.query("after") ?? 0);
    return c.json(store.listMessages(id, Number.isInteger(after) && after > 0 ? after : 0));
  });

  app.post("/tasks/:id/messages", async (c) => {
    const input = await parseBody(c, SendMessageSchema);
    return c.json(orchestrator.sendMessage(idParam(c), input), 201);
  });

  app.get("/tasks/:id/plan", (c) => {
    const id = idParam(c);
    store.getTask(id);
    // No plan yet is a normal state, not an error, so it is null rather than a 404.
    return c.json(store.latestPlan(id));
  });

  app.put("/tasks/:id/plan", async (c) => {
    const { plan } = await parseBody(c, PlanUpdateSchema);
    return c.json(orchestrator.savePlan(idParam(c), plan));
  });

  app.post("/tasks/:id/plan/approve", async (c) => c.json(await orchestrator.approvePlan(idParam(c))));

  app.post("/tasks/:id/plan/send-back", async (c) => {
    const { notes } = await parseBody(c, SendBackSchema);
    return c.json(orchestrator.sendBack(idParam(c), notes));
  });

  // Images for chat. The body is the raw file. The name comes in a header.
  app.post("/tasks/:id/attachments", async (c) => {
    const taskId = idParam(c);
    store.getTask(taskId);
    const mediaType = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    if (!(IMAGE_TYPES as readonly string[]).includes(mediaType)) {
      throw new HttpError(400, "Only PNG, JPEG, GIF and WebP images can be attached");
    }
    // Check the declared size before reading the body into memory, then the real size after.
    if (Number(c.req.header("content-length") ?? 0) > MAX_IMAGE_BYTES) {
      throw new HttpError(400, "Images can be at most 5 MB");
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length === 0) throw new HttpError(400, "The file is empty");
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, "Images can be at most 5 MB");

    let rawName = "";
    try {
      rawName = decodeURIComponent(c.req.header("x-file-name") ?? "");
    } catch {
      // Malformed name. Fall back to a generated one.
    }
    rawName ||= `image.${IMAGE_EXTENSIONS[mediaType]}`;
    const fileName = rawName.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const dir = join(options.attachmentsDir, String(taskId));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.${IMAGE_EXTENSIONS[mediaType]}`);
    writeFileSync(path, bytes);

    const attachment = store.addAttachment({ taskId, fileName, mediaType, size: bytes.length, path });
    return c.json({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType }, 201);
  });

  app.get("/attachments/:id", (c) => {
    const attachment = store.getAttachment(idParam(c));
    if (!existsSync(attachment.path)) throw notFound("Attachment file");
    return c.body(readFileSync(attachment.path), 200, {
      "Content-Type": attachment.mediaType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  // MCP endpoint for the agents' own tools. The token in the path identifies the run.
  app.post("/mcp/:token", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const result = await orchestrator.mcp(c.req.param("token"), body);
    return result === null ? c.body(null, 202) : c.json(result);
  });
  app.on(["GET", "DELETE"], "/mcp/:token", (c) => c.body(null, 405));

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = bus.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      // Keep the connection alive through proxies.
      while (open) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(15_000);
      }
    }),
  );

  return app;
}
