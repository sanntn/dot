import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type Project,
  type TaskKind,
  TASK_KINDS,
  ClaudeAccountQuerySchema,
  RemoteQuerySchema,
  IMAGE_TYPES,
  LANES,
  laneOf,
  type Lane,
  type ProjectOverview,
  COLUMN_LABELS,
  kindDef,
  MAX_IMAGE_BYTES,
  MergeSchema,
  PlanSplitSchema,
  ProposalDecideSchema,
  PlanUpdateSchema,
  REPO_HOST_LABELS,
  ProjectInputSchema,
  ProjectPatchSchema,
  RetrySchema,
  SendBackSchema,
  SendMessageSchema,
  TaskBatchSchema,
  TaskInputSchema,
  IssueImportSchema,
  defaultTaskKind,
  type ExternalIssue,
  type Task,
  MemoryInputSchema,
  MemoryPatchSchema,
  RuleInputSchema,
  RulePatchSchema,
  ScheduleInputSchema,
  SchedulePatchSchema,
  TemplateInputSchema,
  TaskMoveSchema,
  TaskPatchSchema,
  previewPathProblem,
} from "@dot/shared";
import { fileResponse, resolveInside } from "./site.ts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { EventBus } from "./events.ts";
import { claudeAccount, claudeLoginStatus, claudeTokenFor, claudeTokens, startClaudeLogin } from "./agents/claude.ts";
import type { Auth } from "./auth.ts";
import type { Scheduler } from "./scheduler.ts";
import { HttpError, notFound } from "./errors.ts";
import { branchDiff, branchExistsLocally, cloneRepo, gitError, resolveBaseRef } from "./git.ts";
import { Favro, FavroError } from "./favro.ts";
import { GitHub, GitHubError } from "./github.ts";
import { detectRemote, parseRemoteUrl, repoHostFor } from "./githost.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { taskMarkdown } from "./export.ts";
import { cleanStorage, storageReport, type StoragePaths } from "./storage.ts";
import type { Store } from "./store.ts";
import { claudeUsage } from "./usage.ts";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MAX_TASK_IMAGE_BYTES = 100 * 1024 * 1024;

const LOOPBACK_HOSTS =new Set(["127.0.0.1", "localhost", "[::1]"]);

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

  // A preview page runs sandboxed, so its requests look cross-site and carry an Origin of "null". Its files are
  // read-only and the link's token is what authorizes them.
  if (c.req.path.startsWith("/api/site/") && (c.req.method === "GET" || c.req.method === "HEAD")) return null;

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

// A project names one of the server's Claude tokens (DOT_CLAUDE_TOKEN_<NAME>). Blank means the default login.
function checkTokenName(name: string | null | undefined): string | null {
  const trimmed = name?.trim().toUpperCase();
  if (!trimmed) return null;
  if (!claudeTokenFor(trimmed)) {
    throw new HttpError(400, `DOT_CLAUDE_TOKEN_${trimmed} is not set on the server. Add it to the environment and restart Dot.`);
  }
  return trimmed;
}

export function createApp(
  store: Store,
  bus: EventBus,
  orchestrator: Orchestrator,
  options: { attachmentsDir: string; reposDir: string; workspacesDir?: string; prepareAgentFolder?: (folder: string) => void; scheduler?: Scheduler; auth: Auth; allowedHosts?: string[]; storage?: StoragePaths },
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
    // A host or Favro answered with an error. Say what it said, as a gateway error, and not as Dot's own failure.
    if (err instanceof FavroError || err instanceof GitHubError) {
      return c.json({ error: err.message }, err.status === 400 ? 400 : err.status >= 500 || err.status === 401 || err.status === 403 ? 502 : 409);
    }
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

  // A folder is Dot's own clone when it sits directly inside the repos folder. Only those are ever deleted.
  const reposRoot = resolve(options.reposDir);
  const isClone = (repoPath: string) => {
    const path = resolve(repoPath);
    return dirname(path) === reposRoot && basename(path) !== "";
  };
  const withClone = (project: Project): Project => ({ ...project, cloned: isClone(project.repoPath) });

  // A workspace project works in a scratch folder Dot made directly inside the workspaces folder.
  const workspacesRoot = resolve(options.workspacesDir ?? join(options.reposDir, "..", "workspaces"));
  const isWorkspaceFolder = (path: string) => dirname(resolve(path)) === workspacesRoot;

  app.get("/projects", (c) => c.json(store.listProjects().map(withClone)));

  app.post("/projects", async (c) => {
    const parsed = await parseBody(c, ProjectInputSchema);
    const { cloneRepo: given, ...data } = parsed;
    if (data.kind === "workspace") {
      // No repository. The agents get an empty folder of their own to work in.
      // Check the input first, so a refused request leaves no folder behind.
      const claudeConfigDir = checkConfigDir(data.claudeConfigDir);
      const claudeToken = checkTokenName(data.claudeToken);
      const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
      const folder = join(workspacesRoot, `${slug}-${randomBytes(3).toString("hex")}`);
      mkdirSync(folder, { recursive: true });
      let workspace: Project;
      try {
        options.prepareAgentFolder?.(folder);
        workspace = store.createProject({ ...data, repoPath: folder, claudeConfigDir, claudeToken });
      } catch (err) {
        rmSync(folder, { recursive: true, force: true });
        throw err;
      }
      bus.publish({ type: "projects.changed" });
      return c.json(withClone(workspace), 201);
    }
    let baseBranchNote: string | undefined;
    let toClone = given;
    // A pasted remote URL in the path field means "clone this", not a folder called https:/github.com/...
    if (!toClone && data.repoPath && /^([a-z][a-z0-9+.-]*:\/\/|[^\s@/]+@[^\s:/]+:)/i.test(data.repoPath.trim())) {
      const remote = parseRemoteUrl(data.repoPath);
      if (!remote.host || !remote.owner || !remote.name) {
        throw new HttpError(400, `Dot can only clone from GitHub or Bitbucket, and couldn't read a host, owner and repo from ${data.repoPath}`);
      }
      toClone = `${remote.owner}/${remote.name}`;
      data.repoHost ??= remote.host;
    }
    let repoPath: string;
    let { baseBranch, repoHost, repoOwner, repoName } = data;
    if (toClone) {
      // Dot clones it into its own repos folder, once. Later tasks fetch from origin as usual.
      const host = repoHost ?? "github";
      const [owner, name] = toClone.split("/") as [string, string];
      repoPath = join(options.reposDir, `${host}__${owner}__${name}`);
      if (!existsSync(join(repoPath, ".git"))) {
        const domain = host === "bitbucket" ? "bitbucket.org" : "github.com";
        const needs =
          host === "bitbucket"
            ? "DOT_BITBUCKET_TOKEN (and DOT_BITBUCKET_EMAIL for an Atlassian API token) with read access to the repository"
            : "DOT_GITHUB_TOKEN with Contents access to the repository";
        try {
          const checkedOut = await cloneRepo(`https://${domain}/${owner}/${name}.git`, repoPath);
          if (!(await branchExistsLocally(repoPath, baseBranch)) && checkedOut) {
            baseBranchNote = `The repository has no branch "${baseBranch}", so Dot set the base branch to "${checkedOut}", its default.`;
            baseBranch = checkedOut;
          }
        } catch (err) {
          throw new HttpError(502, `Could not clone ${toClone} from ${REPO_HOST_LABELS[host]}: ${gitError(err)}\nA deployed Dot needs ${needs}.`);
        }
      }
      repoHost = host;
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
      claudeToken: checkTokenName(data.claudeToken),
    });
    bus.publish({ type: "projects.changed" });
    return c.json({ ...withClone(project), baseBranchNote }, 201);
  });

  app.patch("/projects/:id", async (c) => {
    const patch = await parseBody(c, ProjectPatchSchema);
    // A workspace's folder is Dot's own. Only a repository project can point somewhere else.
    if (store.getProject(idParam(c)).kind === "workspace") delete patch.repoPath;
    if (patch.repoPath !== undefined) patch.repoPath = checkRepoPath(patch.repoPath);
    if (patch.claudeConfigDir !== undefined) patch.claudeConfigDir = checkConfigDir(patch.claudeConfigDir);
    if (patch.claudeToken !== undefined) patch.claudeToken = checkTokenName(patch.claudeToken);
    const project = store.updateProject(idParam(c), patch);
    bus.publish({ type: "projects.changed" });
    return c.json(withClone(project));
  });

  // ?removeFolder=1 also deletes the clone from disk. Only clones Dot made, and only when no other
  // project still uses the folder.
  app.delete("/projects/:id", async (c) => {
    const id = idParam(c);
    const target = store.listProjects().find((p) => p.id === id);
    // A workspace's scratch folder holds nothing of yours, so it always goes with the project.
    const ownWorkspace = target?.kind === "workspace" && isWorkspaceFolder(target.repoPath);
    const removeFolder = c.req.query("removeFolder") === "1" || ownWorkspace;
    if (removeFolder) {
      if (!target) throw notFound("Project");
      if (!ownWorkspace && !isClone(target.repoPath)) throw new HttpError(400, "Dot only deletes folders it cloned itself.");
      const sharedBy = store.listProjects().find((p) => p.id !== id && resolve(p.repoPath) === resolve(target.repoPath));
      if (sharedBy) throw new HttpError(409, `The folder is also used by the project "${sharedBy.name}".`);
    }
    const tasks = store.listTasks(id);
    // Stop first and wait for exit, so no agent holds its worktree folder while it is removed.
    await Promise.all(tasks.map((task) => orchestrator.stop(task.id)));
    for (const task of tasks) await orchestrator.cleanupWorkspace(task.id);
    store.deleteProject(id);
    for (const task of tasks) removeAttachments(task.id);
    if (removeFolder && target) {
      try {
        rmSync(resolve(target.repoPath), { recursive: true, force: true });
      } catch (err) {
        throw new HttpError(500, `The project was deleted, but its folder could not be removed: ${gitError(err)}`);
      }
    }
    bus.publish({ type: "projects.changed" });
    return c.body(null, 204);
  });

  // Repositories the GitHub token can push to, for the new-project picker. Empty without a token.
  app.get("/github/repos", async (c) => {
    // Bitbucket can't list repositories across workspaces with the tokens Dot uses, so it only reports
    // whether a token is set. You type its workspace/repo.
    const bitbucket = Boolean(process.env.DOT_BITBUCKET_TOKEN?.trim());
    const api = GitHub.fromEnv();
    // A deployed Dot has no local folders worth pointing at, so the dialog starts on cloning.
    const deployed = !["127.0.0.1", "localhost", "::1"].includes(process.env.DOT_HOST?.trim() || "127.0.0.1");
    if (!api) return c.json({ configured: false, bitbucket, deployed, repos: [] });
    try {
      return c.json({ configured: true, bitbucket, deployed, repos: await api.listRepos() });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  });

  // The names of the Claude tokens set on the server, for the project settings. Never the values.
  app.get("/claude-tokens", (c) => c.json(claudeTokens()));

  // Which account a config folder is logged into, for the project settings. POST keeps the path out of URLs.
  app.post("/claude-account", async (c) => {
    const { configDir, token } = await parseBody(c, ClaudeAccountQuerySchema);
    const dir = checkConfigDir(configDir);
    const tokenName = checkTokenName(token);
    // The CLI creates the folder just by checking it, so don't ask about one that isn't there yet.
    if (dir && !tokenName && !existsSync(dir)) {
      return c.json({ loggedIn: false, email: null, orgName: null, subscriptionType: null, configDirectory: dir });
    }
    try {
      return c.json(await claudeAccount(dir, tokenName));
    } catch (err) {
      throw new HttpError(502, `Could not ask the claude CLI: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // How much of the subscription limits that account has used, for the limits widget.
  app.post("/claude-usage", async (c) => {
    const { configDir, token } = await parseBody(c, ClaudeAccountQuerySchema);
    return c.json(await claudeUsage(checkConfigDir(configDir), checkTokenName(token)));
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

  // Lane counts for every project, for the All projects view.
  app.get("/overview", (c) => {
    const overview: ProjectOverview[] = store.listProjects().map((project) => {
      const lanes = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>;
      const waiting: ProjectOverview["waiting"] = [];
      let running = 0;
      for (const task of store.listTasks(project.id)) {
        const lane = laneOf(task);
        lanes[lane] += 1;
        if (task.agentState === "running") running += 1;
        if (lane === "needs_you" && waiting.length < 3) waiting.push({ id: task.id, number: task.number, title: task.title });
      }
      return { projectId: project.id, lanes, running, waiting };
    });
    return c.json(overview);
  });

  // Full text search over briefs, chat, plans, reports and reviews. projectId narrows it to one project.
  app.get("/search", (c) => {
    const projectId = Number(c.req.query("projectId"));
    return c.json(store.search(c.req.query("q") ?? "", Number.isInteger(projectId) && projectId > 0 ? { projectId } : {}));
  });

  // Finished tasks with what they produced, across kinds. Filter by project, kind or search text.
  app.get("/outputs", (c) => {
    const projectId = Number(c.req.query("projectId"));
    const kind = c.req.query("kind");
    if (kind && !(TASK_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "Unknown kind");
    return c.json(
      store.listOutputs({
        projectId: Number.isInteger(projectId) && projectId > 0 ? projectId : undefined,
        kind: kind as TaskKind | undefined,
        q: c.req.query("q") ?? "",
      }),
    );
  });

  // The views that look across tasks. Each takes an optional projectId.
  const scope = (c: Context) => {
    const projectId = Number(c.req.query("projectId"));
    return Number.isInteger(projectId) && projectId > 0 ? projectId : undefined;
  };
  app.get("/documents", (c) => c.json(store.listDocuments({ projectId: scope(c), q: c.req.query("q") ?? "" })));
  app.get("/triage", (c) => c.json(store.listTriage({ projectId: scope(c) })));
  app.get("/feed", (c) => c.json(store.listFeed({ projectId: scope(c), scheduledOnly: c.req.query("scheduled") === "1" })));

  // Disk usage, and cleanup of finished tasks' worktrees and orphan folders.
  app.get("/storage", async (c) => {
    if (!options.storage) throw new HttpError(404, "Storage is not set up");
    return c.json(await storageReport(store, options.storage));
  });
  app.post("/storage/clean", async (c) => {
    if (!options.storage) throw new HttpError(404, "Storage is not set up");
    return c.json(await cleanStorage(store, options.storage));
  });

  app.get("/projects/:id/tasks", (c) => c.json(store.listTasks(idParam(c))));

  app.post("/tasks", async (c) => {
    const task = store.createTask(await parseBody(c, TaskInputSchema));
    bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    return c.json(task, 201);
  });

  // Several tasks from a pasted list. One change event, so the board refetches once.
  app.post("/tasks/batch", async (c) => {
    const { projectId, titles, kind } = await parseBody(c, TaskBatchSchema);
    const tasks = titles.map((title) => store.createTask({ projectId, title, description: "", kind, blockedBy: [] }));
    bus.publish({ type: "tasks.changed", projectId });
    return c.json(tasks, 201);
  });

  // Rules the project's agents follow. Suggestions from reviews sit here until you accept or dismiss them.
  app.get("/projects/:id/rules", (c) => c.json(store.listRules(idParam(c))));
  app.post("/projects/:id/rules", async (c) => {
    const { text } = await parseBody(c, RuleInputSchema);
    const rule = store.addRule(idParam(c), text, "active");
    if (!rule) throw new HttpError(409, "The project already has this rule.");
    return c.json(rule, 201);
  });
  app.patch("/rules/:id", async (c) => c.json(store.updateRule(idParam(c), await parseBody(c, RulePatchSchema))));
  app.delete("/rules/:id", (c) => {
    store.deleteRule(idParam(c));
    return c.body(null, 204);
  });

  // Notes the project's agents saved. You can add, edit and delete them.
  app.get("/projects/:id/memory", (c) => c.json(store.listMemory(idParam(c))));
  app.post("/projects/:id/memory", async (c) => {
    const { text } = await parseBody(c, MemoryInputSchema);
    const note = store.addMemory(idParam(c), text);
    if (!note) throw new HttpError(409, "The project already has this note.");
    return c.json(note, 201);
  });
  app.patch("/memory/:id", async (c) => c.json(store.updateMemory(idParam(c), await parseBody(c, MemoryPatchSchema))));
  app.delete("/memory/:id", (c) => {
    store.deleteMemory(idParam(c));
    return c.body(null, 204);
  });

  // Open issues on the project's host, to import as tasks. Each says which task it already made, if any.
  app.get("/projects/:id/issues", async (c) => {
    const project = store.getProject(idParam(c));
    const remote = await repoHostFor(project);
    if (!remote.listIssues) throw new HttpError(409, `Importing issues works with GitHub projects only. This one is on ${remote.label}.`);
    const label = c.req.query("label")?.trim() || undefined;
    const issues = await remote.listIssues({ label });
    return c.json(
      issues.map((i) => ({ ...i, taskId: store.findTaskBySource(project.id, `github:${remote.owner}/${remote.name}#${i.number}`)?.id ?? null })),
    );
  });
  // Makes a task from each picked issue. The text is read again from GitHub, never taken from the request.
  app.post("/projects/:id/issues/import", async (c) => {
    const input = await parseBody(c, IssueImportSchema);
    const project = store.getProject(idParam(c));
    if (project.kind !== "repo") throw new HttpError(409, "Only a project with a repository can import issues");
    const remote = await repoHostFor(project);
    if (!remote.getIssue) throw new HttpError(409, `Importing issues works with GitHub projects only. This one is on ${remote.label}.`);
    const getIssue = remote.getIssue;
    return c.json(
      await importItems(project, input, {
        what: "GitHub issue",
        refFor: (n) => `github:${remote.owner}/${remote.name}#${n}`,
        // Each issue is read by number, so one outside the newest page or the label filter still imports.
        fetchOne: (n) => getIssue(n),
        kind: "code",
      }),
      201,
    );
  });

  // Cards on the project's Favro board, to import as tasks. `column` limits them to one column by name.
  app.get("/projects/:id/favro/cards", async (c) => {
    const project = store.getProject(idParam(c));
    const { favro, board } = favroFor(project);
    const { cards, truncated } = await favro.listCards(board, c.req.query("column")?.trim() || undefined);
    const prefix = await favro.refPrefix();
    return c.json({
      cards: cards.map((card) => ({ ...card, taskId: store.findTaskBySource(project.id, `${prefix}${card.number}`)?.id ?? null })),
      truncated,
    });
  });
  app.post("/projects/:id/favro/import", async (c) => {
    const input = await parseBody(c, IssueImportSchema);
    const project = store.getProject(idParam(c));
    const { favro } = favroFor(project);
    const prefix = await favro.refPrefix();
    return c.json(
      await importItems(project, input, {
        what: "Favro card",
        refFor: (n) => `${prefix}${n}`,
        fetchOne: (n) => favro.getCard(n),
        kind: defaultTaskKind(project.kind),
      }),
      201,
    );
  });

  // The Favro client and board for a project, or a 409 that says what to set.
  function favroFor(project: Project) {
    const board = project.favroBoard?.trim();
    if (!board) throw new HttpError(409, "Set the Favro board in the project settings first.");
    const favro = Favro.fromEnv();
    if (!favro) throw new HttpError(409, "Set DOT_FAVRO_EMAIL and DOT_FAVRO_TOKEN in Dot's .env file first. Then restart Dot.");
    return { favro, board };
  }

  // Makes a task from each picked number, reading the item again from its source and never from the request.
  // Numbers that made no task come back with the reason, so the dialog can say so.
  async function importItems(
    project: Project,
    input: { numbers: number[]; start: boolean },
    source: { what: string; refFor: (n: number) => string; fetchOne: (n: number) => Promise<ExternalIssue | null>; kind: TaskKind },
  ) {
    const made: Task[] = [];
    const skipped: { number: number; reason: string }[] = [];
    for (const number of new Set(input.numbers)) {
      const ref = source.refFor(number);
      if (store.findTaskBySource(project.id, ref)) {
        skipped.push({ number, reason: "already a task" });
        continue;
      }
      const item = await source.fetchOne(number);
      if (!item) {
        skipped.push({ number, reason: "not found or not open" });
        continue;
      }
      const description = [`Imported from ${source.what} #${number}${item.url ? ` (${item.url})` : ""}.`, item.body.trim()]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 20000);
      made.push(
        store.createTask({ projectId: project.id, title: item.title.slice(0, 200), description, kind: source.kind, blockedBy: [] }, null, { ref, url: item.url || null }),
      );
    }
    bus.publish({ type: "tasks.changed", projectId: project.id });
    if (input.start) {
      for (const task of made) {
        try {
          orchestrator.startResearch(task.id);
        } catch (err) {
          skipped.push({ number: Number(task.sourceRef?.match(/#(\d+)$/)?.[1] ?? 0), reason: `made, but research did not start: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
    return { tasks: made, skipped };
  }

  app.get("/projects/:id/templates", (c) => c.json(store.listTemplates(idParam(c))));
  app.post("/projects/:id/templates", async (c) =>
    c.json(store.addTemplate(idParam(c), await parseBody(c, TemplateInputSchema)), 201),
  );
  app.delete("/templates/:id", (c) => {
    store.deleteTemplate(idParam(c));
    return c.body(null, 204);
  });

  // Schedules make a task on a rhythm and start its research.
  app.get("/projects/:id/schedules", (c) => c.json(store.listSchedules(idParam(c))));
  app.post("/projects/:id/schedules", async (c) =>
    c.json(store.addSchedule(idParam(c), await parseBody(c, ScheduleInputSchema)), 201),
  );
  app.patch("/schedules/:id", async (c) => c.json(store.updateSchedule(idParam(c), await parseBody(c, SchedulePatchSchema))));
  app.delete("/schedules/:id", (c) => {
    store.deleteSchedule(idParam(c));
    return c.body(null, 204);
  });
  app.post("/schedules/:id/run", (c) => {
    if (!options.scheduler) throw new HttpError(404, "Schedules are not set up");
    const task = options.scheduler.runNow(idParam(c));
    return c.json({ task, schedule: store.getSchedule(idParam(c)) }, 201);
  });

  app.patch("/tasks/:id", async (c) => {
    const task = store.updateTask(idParam(c), await parseBody(c, TaskPatchSchema));
    bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    return c.json(task);
  });

  app.post("/tasks/:id/move", async (c) => {
    const move = await parseBody(c, TaskMoveSchema);
    const current = store.getTask(idParam(c));
    if (!kindDef(current.kind).columns.includes(move.column)) {
      throw new HttpError(400, `A ${kindDef(current.kind).label.toLowerCase()} task has no ${COLUMN_LABELS[move.column]} column`);
    }
    const task = store.moveTask(current.id, move);
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
    if (task.column === "research") {
      const started = store.latestRun(task.id, "research") !== null;
      return c.json(started ? orchestrator.resumeResearch(task.id) : orchestrator.startResearch(task.id));
    }
    if (task.column === "execute") return c.json(await orchestrator.startExecution(task.id));
    if (task.column === "review") return c.json(await orchestrator.startReview(task.id));
    throw new HttpError(409, "There is no agent to start for this column");
  });

  // Throws away one agent's session and starts that stage again.
  app.post("/tasks/:id/retry", async (c) => {
    const { stage } = await parseBody(c, RetrySchema);
    return c.json(await orchestrator.retryFrom(idParam(c), stage));
  });

  // The task as a Markdown file: request, latest plan, report and review, and history.
  app.get("/tasks/:id/export", (c) => {
    const id = idParam(c);
    const task = store.getTask(id);
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="task-${task.number}-${slug}.md"`);
    return c.body(taskMarkdown(store, id));
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

  app.get("/tasks/:id/events", (c) => {
    const id = idParam(c);
    store.getTask(id);
    return c.json(store.listEvents(id));
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

  // Takes a picture of the task's running dev server. It finishes in the background and posts in the chat.
  app.post("/tasks/:id/preview", (c) => c.json(orchestrator.startPreview(idParam(c)), 202));

  // A link that opens the task's preview page in a browser tab, to click through it yourself. Dot serves
  // the worktree's files for a few hours, with a sandbox that keeps the page's scripts away from Dot's API.
  app.post("/tasks/:id/site-link", (c) => {
    const task = store.getTask(idParam(c));
    const project = store.getProject(task.projectId);
    const page = project.previewPath;
    if (!page || previewPathProblem(page) || project.devCommand) {
      throw new HttpError(409, "Set a preview page in the project settings, and leave the dev command empty.");
    }
    if (!task.worktreePath || !existsSync(task.worktreePath)) throw new HttpError(409, "The worktree was removed, so there is nothing to open");
    const path = page.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
    return c.json({ url: `/api/site/${options.auth.siteToken(task.id)}/${path}` });
  });

  app.get("/site/:token/*", (c) => {
    const token = c.req.param("token");
    const taskId = options.auth.siteTaskId(token);
    if (taskId === null) throw notFound("Page");
    const task = store.getTask(taskId);
    if (!task.worktreePath) throw notFound("Page");
    const rest = new URL(c.req.url).pathname.slice(`/api/site/${token}`.length) || "/";
    const file = resolveInside(task.worktreePath, rest);
    if (!file) throw notFound("Page");
    return fileResponse(file, c.req.method, c.req.header("range"), {
      // No same-origin rights: the page cannot call Dot's API, read its cookies or open its storage.
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
  });
  app.post("/tasks/:id/plan/split-all", (c) => c.json(orchestrator.splitIntoSubtasks(idParam(c)), 201));
  app.post("/tasks/:id/plan/split", async (c) => {
    const input = await parseBody(c, PlanSplitSchema);
    return c.json(orchestrator.splitPlan(idParam(c), input), 201);
  });

  app.post("/tasks/:id/plan/approve", async (c) => c.json(await orchestrator.approvePlan(idParam(c))));

  // A report task's document. Approving finishes the task.
  app.get("/tasks/:id/doc", (c) => c.json(store.latestReportDoc(store.getTask(idParam(c)).id)));
  app.post("/tasks/:id/doc/approve", async (c) => c.json(await orchestrator.approveReportDoc(idParam(c))));
  app.post("/tasks/:id/doc/send-back", async (c) => {
    const { notes } = await parseBody(c, SendBackSchema);
    return c.json(orchestrator.sendBackReportDoc(idParam(c), notes));
  });

  // A triage task's proposed tasks. Accept or reject items, then finish.
  app.get("/tasks/:id/proposals", (c) => c.json(store.latestProposals(store.getTask(idParam(c)).id)));
  app.post("/tasks/:id/proposals/decide", async (c) => {
    const input = await parseBody(c, ProposalDecideSchema);
    return c.json(orchestrator.decideProposals(idParam(c), input));
  });
  app.post("/tasks/:id/proposals/finish", async (c) => c.json(await orchestrator.finishTriage(idParam(c))));
  app.post("/tasks/:id/proposals/send-back", async (c) => {
    const { notes } = await parseBody(c, SendBackSchema);
    return c.json(orchestrator.sendBackProposals(idParam(c), notes));
  });

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
    // Chat images have no count limit, so cap what one task keeps on disk.
    if (store.attachmentBytes(taskId) + bytes.length > MAX_TASK_IMAGE_BYTES) {
      throw new HttpError(400, "This task already holds 100 MB of images. Delete the task or start a new one.");
    }

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

    const origin = c.req.query("kind") === "task" ? "task" : "chat";
    if (origin === "task" && store.taskAttachments(taskId).length >= 5) {
      rmSync(path, { force: true });
      throw new HttpError(400, "A task can have at most 5 images");
    }
    const attachment = store.addAttachment({ taskId, fileName, mediaType, size: bytes.length, path, origin });
    return c.json({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType }, 201);
  });

  app.get("/tasks/:id/attachments", (c) => {
    const id = idParam(c);
    store.getTask(id);
    return c.json(store.taskAttachments(id).map((a) => ({ id: a.id, fileName: a.fileName, mediaType: a.mediaType })));
  });

  app.delete("/attachments/:id", (c) => {
    const path = store.removeTaskAttachment(idParam(c));
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.error("Could not remove an attachment file:", err);
    }
    return c.body(null, 204);
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
