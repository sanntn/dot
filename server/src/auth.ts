import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

// Single-user password login for a Dot that is reachable over a network.
// DOT_PASSWORD turns it on. The session is a signed cookie, so nothing is stored on the server and
// a restart does not sign you out. Changing DOT_PASSWORD (or DOT_SESSION_SECRET) signs everyone out.

const COOKIE = "dot_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

const digest = (value: string) => createHash("sha256").update(value).digest();
const sameText = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export class Auth {
  private failures = 0;
  private lockedUntil = 0;
  private readonly key: Buffer;

  constructor(private readonly password: string | null, secret: string | null) {
    this.key = digest(`dot-session:${secret || password || ""}`);
  }

  get enabled(): boolean {
    return this.password !== null;
  }

  private sign(expires: number): string {
    return createHmac("sha256", this.key).update(String(expires)).digest("base64url");
  }

  isSignedIn(c: Context): boolean {
    if (!this.enabled) return true;
    const cookie = getCookie(c, COOKIE);
    if (!cookie) return false;
    const [expires, signature] = cookie.split(".");
    if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
    return sameText(signature, this.sign(Number(expires)));
  }

  // Returns an error message, or null when the password was right and the cookie is set.
  signIn(c: Context, supplied: string): string | null {
    const now = Date.now();
    if (now < this.lockedUntil) {
      return `Too many wrong passwords. Try again in ${Math.ceil((this.lockedUntil - now) / 1000)} seconds.`;
    }
    if (!this.password || !sameText(supplied, this.password)) {
      this.failures++;
      if (this.failures >= MAX_FAILURES) {
        this.failures = 0;
        this.lockedUntil = now + LOCKOUT_MS;
      }
      return "Wrong password";
    }
    this.failures = 0;
    const expires = now + SESSION_MS;
    setCookie(c, COOKIE, `${expires}.${this.sign(expires)}`, {
      httpOnly: true,
      sameSite: "Strict",
      // Coolify's proxy ends TLS, so the request itself arrives as plain http.
      secure: c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_MS / 1000,
    });
    return null;
  }

  signOut(c: Context): void {
    deleteCookie(c, COOKIE, { path: "/" });
  }

  // Blocks the API for anyone who is not signed in. Agents reach /api/mcp with a per-run token
  // instead, and the health check and login routes must work signed out.
  middleware = async (c: Context, next: Next) => {
    const path = c.req.path;
    const open = path === "/api/health" || path === "/api/login" || path === "/api/session" || path.startsWith("/api/mcp/");
    if (open || this.isSignedIn(c)) return next();
    return c.json({ error: "Sign in required" }, 401);
  };
}
