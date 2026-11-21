import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Secrets can come from files outside the repository, so they need not sit in `.env`. An agent that runs
// as you can read any file you can, so the file is a smaller target rather than a locked one, but Dot
// closes the path to it the same way it closes `.env` (see guards.ts and the sandbox in claude.ts).
//
// DOT_GITHUB_TOKEN_FILE=/home/me/.dot/github-token sets DOT_GITHUB_TOKEN to the file's contents. The usual
// secret mounts work the same way: Docker and Coolify put them in /run/secrets/<name>.

// The settings that hold a secret: passwords, signing keys and tokens. Other settings are read as they are.
const SECRET = /^DOT_(PASSWORD|SESSION_SECRET|BITBUCKET_TOKEN|GITHUB_TOKEN|FAVRO_TOKEN|CLAUDE_TOKEN(_[A-Z0-9_]+)?)$/;

export const isSecretName = (name: string): boolean => SECRET.test(name);

// Reads every DOT_<SECRET>_FILE into DOT_<SECRET>. A value already set directly wins. Returns the files read,
// so the caller can keep agents away from them. Throws when a named file can't be read, since starting
// without the token would only fail later at the merge step.
export function loadSecretFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const files: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith("_FILE") || !value?.trim()) continue;
    const name = key.slice(0, -"_FILE".length);
    if (!isSecretName(name)) continue;
    const file = resolve(value.trim());
    files.push(file);
    if (env[name]?.trim()) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`${key} points to ${file}, which can't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    // One trailing newline is how editors and `echo` leave a file. It is not part of the secret.
    const secret = text.replace(/\r?\n$/, "");
    if (!secret.trim()) throw new Error(`${key} points to ${file}, which is empty.`);
    env[name] = secret;
  }
  return files;
}

// The secrets a `.env` file holds in plain text. Dot warns about them when agents run as you.
export function secretsInEnvFile(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !isSecretName(m[1]!)) continue;
    // An empty value, or an empty quoted one, sets nothing.
    if (m[2]!.replace(/^["']|["']$/g, "").trim() !== "") found.add(m[1]!);
  }
  return [...found];
}
