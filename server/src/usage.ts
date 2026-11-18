import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeUsage, UsageLimit, UsageSpend } from "@dot/shared";
import { claudeTokenFor } from "./agents/claude.ts";
import { HttpError } from "./errors.ts";

// Reads how much of the subscription limits an account has used. This is the call Claude Code's /usage
// makes. The endpoint is not documented, so every field is read defensively and a change in its shape
// shows up as an empty widget with a message, not a crash. The token stays on the server.

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CACHE_MS = 3 * 60_000;
const DEFAULT_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const cache = new Map<string, { at: number; usage: ClaudeUsage }>();
const blockedUntil = new Map<string, number>();

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function severity(value: unknown, percent: number): UsageLimit["severity"] {
  if (value === "critical" || value === "warning" || value === "normal") return value;
  return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";
}

// The login the CLI stores in the config folder. On macOS the CLI uses the keychain instead, so
// there is no file to read and the account needs a token.
function loginToken(configDir: string | null): string {
  const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR?.trim() ?? join(homedir(), ".claude");
  let oauth: Json | null;
  try {
    oauth = obj(obj(JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")))?.claudeAiOauth);
  } catch {
    throw new HttpError(422, `No Claude login found in ${dir}. Sign in with claude auth login, or set DOT_CLAUDE_TOKEN.`);
  }
  const token = str(oauth?.accessToken);
  if (!token) throw new HttpError(422, `The login in ${dir} has no access token. Sign in again with claude auth login.`);
  const expires = num(oauth?.expiresAt);
  // Dot never refreshes the token itself. Refresh tokens rotate, so doing it here could sign the CLI out.
  if (expires !== null && expires < Date.now()) {
    throw new HttpError(422, "The Claude login has expired. Run claude once to refresh it, then reload the limits.");
  }
  return token;
}

function limitLabel(kind: string, scope: Json | null): string {
  if (kind === "session") return "Current session";
  if (kind === "weekly_all") return "Weekly, all models";
  if (kind === "weekly_scoped") {
    const model = str(obj(scope?.model)?.display_name);
    const surface = str(obj(scope?.surface)?.display_name);
    const name = [model, surface].filter(Boolean).join(" on ");
    return name ? `Weekly, ${name}` : "Weekly, scoped";
  }
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function parseLimits(data: Json): UsageLimit[] {
  const out: UsageLimit[] = [];
  if (Array.isArray(data.limits)) {
    data.limits.forEach((raw, index) => {
      const item = obj(raw);
      const kind = str(item?.kind);
      const percent = num(item?.percent);
      if (!item || !kind || percent === null) return;
      out.push({
        id: `${kind}:${index}`,
        label: limitLabel(kind, obj(item.scope)),
        group: item.group === "session" ? "session" : "weekly",
        percent,
        severity: severity(item.severity, percent),
        resetsAt: str(item.resets_at),
      });
    });
    if (out.length > 0) return out;
  }
  // Older responses only carry the flat windows.
  const flat: [string, string, UsageLimit["group"]][] = [
    ["five_hour", "Current session", "session"],
    ["seven_day", "Weekly, all models", "weekly"],
    ["seven_day_opus", "Weekly, Opus", "weekly"],
    ["seven_day_sonnet", "Weekly, Sonnet", "weekly"],
  ];
  for (const [key, label, group] of flat) {
    const item = obj(data[key]);
    const percent = num(item?.utilization);
    if (!item || percent === null) continue;
    out.push({ id: key, label, group, percent, severity: severity(null, percent), resetsAt: str(item.resets_at) });
  }
  return out;
}

function parseSpend(data: Json): UsageSpend | null {
  const spend = obj(data.spend);
  if (!spend || spend.enabled === false) return null;
  const used = obj(spend.used);
  const usedMinor = num(used?.amount_minor);
  const currency = str(used?.currency);
  if (usedMinor === null || !currency) return null;
  const limit = obj(spend.limit);
  const percent = num(spend.percent) ?? 0;
  return {
    usedMinor,
    limitMinor: num(limit?.amount_minor),
    currency,
    exponent: num(used?.exponent) ?? 2,
    percent,
    severity: severity(spend.severity, percent),
  };
}

export async function claudeUsage(configDir: string | null, tokenName: string | null): Promise<ClaudeUsage> {
  const key = `${tokenName ?? ""}|${configDir ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.usage;
  // After a 429, stay quiet until Anthropic says to come back. Asking again only extends the wait.
  const wait = (blockedUntil.get(key) ?? 0) - Date.now();
  if (wait > 0) {
    if (cached) return cached.usage;
    throw new HttpError(422, `Anthropic is limiting how often limits can be checked. Try again in ${Math.ceil(wait / 60_000)} min.`);
  }

  const token =
    (tokenName ? claudeTokenFor(tokenName) : null) ||
    (!configDir ? process.env.DOT_CLAUDE_TOKEN?.trim() : undefined) ||
    loginToken(configDir);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "dot" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (cached) return cached.usage;
    throw new HttpError(422, `Could not reach Anthropic: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      422,
      "This login can't read limits. Tokens from claude setup-token only cover inference. Use a browser login (claude auth login) for this account.",
    );
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_BACKOFF_MS;
    blockedUntil.set(key, Date.now() + Math.min(backoff, MAX_BACKOFF_MS));
  }
  if (!res.ok) {
    // A rate-limited or failing endpoint still has an answer from earlier. Show it instead of an error.
    if (cached) return cached.usage;
    if (res.status === 429) {
      throw new HttpError(422, `Anthropic is limiting how often limits can be checked. Try again in ${Math.ceil((blockedUntil.get(key)! - Date.now()) / 60_000)} min.`);
    }
    throw new HttpError(422, `Anthropic answered ${res.status} when asked for limits`);
  }

  const data = obj(await res.json().catch(() => null));
  if (!data) throw new HttpError(422, "Anthropic sent limits in a format Dot does not recognize");
  const usage: ClaudeUsage = { limits: parseLimits(data), spend: parseSpend(data), fetchedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), usage });
  return usage;
}
