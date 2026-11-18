import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { Auth } from "./auth.ts";
import { startBackups } from "./backup.ts";
import { openDb } from "./db.ts";
import { EventBus } from "./events.ts";
import { guardRules } from "./agents/guards.ts";
import { configureTransport } from "./git.ts";
import { agentDir, isolated, verifyIsolation } from "./isolation.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store.ts";

const root = resolve(import.meta.dirname, "../..");
try {
  process.loadEnvFile(resolve(root, ".env"));
} catch {
  // No .env file. Defaults apply.
}

const port = Number(process.env.DOT_PORT ?? 4317);
const dataDir = resolve(process.env.DOT_DATA_DIR ?? resolve(root, "data"));
const host = process.env.DOT_HOST?.trim() || "127.0.0.1";
const auth = new Auth(
  process.env.DOT_PASSWORD || null,
  process.env.DOT_SESSION_SECRET || null,
  resolve(dataDir, "session.json"),
);
const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);
if (!isLoopback && !auth.enabled) {
  // Dot runs agents with shell access. Never serve it to a network without a login.
  console.error(`DOT_HOST=${host} exposes Dot to the network, so DOT_PASSWORD must be set. Refusing to start.`);
  process.exit(1);
}
const dbFile = process.env.DOT_DB ?? resolve(dataDir, "dot.db");

// In the Docker image the server runs as root and the agents as an unprivileged user (see isolation.ts).
// Everything the server creates stays private to it. The folders agents work in are handed over below.
if (isolated) process.umask(0o077);
const worktreesDir = resolve(dataDir, "worktrees");
const reposDir = resolve(dataDir, "repos");
const backupsDir = resolve(dataDir, "backups");
if (isolated) {
  agentDir(worktreesDir);
  agentDir(reposDir);
  configureTransport(resolve(dataDir, "transport"));
}

const db = openDb(dbFile);
const store = new Store(db);
// After the database exists, so the check can try to read it as the agent user. Refuses to start
// when an agent could reach something private, rather than running agents quietly with too much access.
try {
  verifyIsolation([dbFile, `${dbFile}-wal`, `${dbFile}-shm`, resolve(dataDir, "session.json"), resolve(dataDir, "attachments"), backupsDir]);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
// A snapshot of the database at startup and then daily, so a bad migration or a disk fault costs a day.
const stopBackups = startBackups(db, {
  dir: backupsDir,
  keep: Math.max(0, Number(process.env.DOT_BACKUP_KEEP ?? 7)),
});
process.on("exit", stopBackups);
const bus = new EventBus();
const orchestrator = new Orchestrator(store, bus, {
  port,
  maxAgents: Math.max(1, Number(process.env.DOT_MAX_AGENTS ?? 2)),
  model: process.env.DOT_MODEL ?? "opus",
  // Minutes of silence before a working agent is stopped and flagged. 0 turns the check off.
  stuckAfterMs: Math.max(0, Number(process.env.DOT_STUCK_MINUTES ?? 20)) * 60_000,
  // Outside any repo, so worktrees never show up as untracked files in your checkout.
  worktreesDir,
  guardRules: guardRules({ port, root, dataDir, dbFile }),
});
orchestrator.recover();
orchestrator.startUnblocked();

// Don't leave claude processes running when Dot stops or restarts.
process.on("exit", () => orchestrator.shutdown());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => process.exit(0));
}

const api = createApp(store, bus, orchestrator, {
  attachmentsDir: resolve(dataDir, "attachments"),
  reposDir,
  auth,
  allowedHosts: (process.env.DOT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
});

// In a deployed Dot the server also serves the built board. In development Vite does that.
const app = new Hono();
app.route("/", api);
const webDir = resolve(process.env.DOT_WEB_DIR ?? resolve(root, "web/dist"));
if (existsSync(resolve(webDir, "index.html"))) {
  const rel = relative(process.cwd(), webDir).replaceAll("\\", "/") || ".";
  app.use("*", serveStatic({ root: rel }));
  // Unknown paths outside the API get the board, so a reload on any URL works.
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : serveStatic({ root: rel, path: "index.html" })(c, next)));
}

// Loopback by default. Dot runs agents with shell access, so a network address needs DOT_PASSWORD (checked above).
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Dot server on http://${host}:${info.port} (db: ${dbFile}${auth.enabled ? ", password login on" : ""})`);
});
