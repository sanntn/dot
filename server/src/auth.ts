import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

// Single-user password login for a Dot that is reachable over a network.
// DOT_PASSWORD turns it on. The session is a signed cookie, so a restart does not sign you out.
// The signing key comes from a random secret, not from the password, so a copied cookie gives an
// attacker nothing to guess the password from. The secret is DOT_SESSION_SECRET when set, otherwise
// one Dot generates once and keeps in its data folder. Changing DOT_PASSWORD or the secret signs
// everyone out. So does Sign out: it revokes every cookie issued before it.

const COOKIE = "dot_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SITE_LINK_MS = 4 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const MAX_TRACKED_CLIENTS = 1000;

const digest = (value: string) => createHash("sha256").update(value).digest();
const sameText = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

type State = { secret: string; revokedBefore: number };

export class Auth {
  private readonly attempts = new Map<string, { failures: number; lockedUntil: number }>();
  private readonly key: Buffer;
  private state: State;

  // `stateFile` holds the generated secret and the sign-out time. Null keeps them in memory only.
  constructor(
    private readonly password: string | null,
    envSecret: string | null,
    private readonly stateFile: string | null = null,
  ) {
    this.state = this.loadState(envSecret);
    this.key = digest(`dot-session:${this.state.secret}:${digest(password ?? "").toString("hex")}`);
  }

  private loadState(envSecret: string | null): State {
    let saved: Partial<State> = {};
    if (this.stateFile) {
      try {
        saved = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<State>;
      } catch {
        // First start, or an unreadable file. A new one is written below.
      }
    }
    const state: State = {
      secret: envSecret || (typeof saved.secret === "string" && saved.secret ? saved.secret : randomBytes(32).toString("hex")),
      revokedBefore: typeof saved.revokedBefore === "number" ? saved.revokedBefore : 0,
    };
    this.fromEnv = Boolean(envSecret);
    if (this.password !== null && !this.fromEnv && saved.secret !== state.secret) this.save(state);
    return state;
  }

  private fromEnv = false;

  private save(state: State): void {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      // A secret from DOT_SESSION_SECRET stays in the environment and is never written to disk.
      const saved: State = { ...state, secret: this.fromEnv ? "" : state.secret };
      writeFileSync(this.stateFile, JSON.stringify(saved), { mode: 0o600 });
    } catch (err) {
      console.error("Could not save the session state. A restart will sign everyone out:", err);
    }
  }

  get enabled(): boolean {
    return this.password !== null;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  isSignedIn(c: Context): boolean {
    if (!this.enabled) return true;
    const cookie = getCookie(c, COOKIE);
    if (!cookie) return false;
    const [issued, expires, signature, ...extra] = cookie.split(".");
    if (!issued || !expires || !signature || extra.length > 0) return false;
    if (!/^\d+$/.test(issued) || !/^\d+$/.test(expires)) return false;
    if (Number(expires) < Date.now() || Number(issued) <= this.state.revokedBefore) return false;
    return sameText(signature, this.sign(`${issued}.${expires}`));
  }

  // Who is asking, for the failed-login counter. Behind a proxy every request comes from the proxy,
  // so DOT_TRUST_PROXY=true reads the address the proxy appended to X-Forwarded-For (the last entry).
  // Without a proxy that header is client-controlled, so it is ignored.
  private clientKey(c: Context): string {
    if (process.env.DOT_TRUST_PROXY === "true") {
      const last = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
      if (last) return last;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private forgetOldClients(now: number): void {
    if (this.attempts.size < MAX_TRACKED_CLIENTS) return;
    for (const [client, entry] of this.attempts) if (entry.lockedUntil < now) this.attempts.delete(client);
    if (this.attempts.size >= MAX_TRACKED_CLIENTS) this.attempts.clear();
  }

  // Returns an error message, or null when the password was right and the cookie is set.
  signIn(c: Context, supplied: string): string | null {
    const now = Date.now();
    const client = this.clientKey(c);
    const entry = this.attempts.get(client) ?? { failures: 0, lockedUntil: 0 };
    if (now < entry.lockedUntil) {
      return `Too many wrong passwords. Try again in ${Math.ceil((entry.lockedUntil - now) / 1000)} seconds.`;
    }
    if (!this.password || !sameText(supplied, this.password)) {
      this.forgetOldClients(now);
      entry.failures++;
      if (entry.failures >= MAX_FAILURES) {
        entry.failures = 0;
        entry.lockedUntil = now + LOCKOUT_MS;
      }
      this.attempts.set(client, entry);
      return "Wrong password";
    }
    this.attempts.delete(client);
    const expires = now + SESSION_MS;
    setCookie(c, COOKIE, `${now}.${expires}.${this.sign(`${now}.${expires}`)}`, {
      httpOnly: true,
      sameSite: "Strict",
      // Coolify's proxy ends TLS, so the request itself arrives as plain http.
      secure: c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_MS / 1000,
    });
    return null;
  }

  // Revokes every cookie issued so far, on every device, not only this browser's copy.
  signOut(c: Context): void {
    this.state = { ...this.state, revokedBefore: Date.now() };
    this.save(this.state);
    deleteCookie(c, COOKIE, { path: "/" });
  }

  // A link to one task's preview page, good for a few hours. The page runs in a sandbox with no cookies,
  // so its own stylesheets, scripts and fonts cannot carry the session. The token in the path stands in for it.
  siteToken(taskId: number): string {
    const issued = Date.now();
    const payload = `${taskId}.${issued}.${issued + SITE_LINK_MS}`;
    return `${payload}.${this.sign(`site:${payload}`)}`;
  }

  // The task a site token is for, or null when it is forged, expired or older than the last sign-out.
  siteTaskId(token: string): number | null {
    const [task, issued, expires, signature, ...extra] = token.split(".");
    if (!task || !issued || !expires || !signature || extra.length > 0) return null;
    if (![task, issued, expires].every((n) => /^\d+$/.test(n))) return null;
    if (Number(expires) < Date.now() || Number(issued) <= this.state.revokedBefore) return null;
    return sameText(signature, this.sign(`site:${task}.${issued}.${expires}`)) ? Number(task) : null;
  }

  // Blocks the API for anyone who is not signed in. Agents reach /api/mcp with a per-run token
  // instead, preview pages reach /api/site with a per-task token, and the health check and login
  // routes must work signed out.
  middleware = async (c: Context, next: Next) => {
    const path = c.req.path;
    const open =
      path === "/api/health" || path === "/api/login" || path === "/api/session" || path.startsWith("/api/mcp/") || path.startsWith("/api/site/");
    if (open || this.isSignedIn(c)) return next();
    return c.json({ error: "Sign in required" }, 401);
  };
}
