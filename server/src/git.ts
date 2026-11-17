import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Commit, DiffFile, TaskDiff } from "@dot/shared";

const run = promisify(execFile);

// An empty folder used as Dot's hooks path, so Dot's own git calls never run repository hooks.
const NO_HOOKS = join(tmpdir(), "dot-no-hooks");
mkdirSync(NO_HOOKS, { recursive: true });

// Git through execFile (no shell), so branch names and paths are never interpreted.
// Async, so a slow git call never blocks the server, its live updates or the agents' tool calls.
//
// These calls run with Dot's rights, in a .git folder the executor's shell can write to. So:
// - no hooks and no fsmonitor command, which a planted .git/hooks file or config entry could set;
// - none of Dot's own settings (DOT_*, which holds the Bitbucket and GitHub tokens) in git's environment;
// - core.quotePath=false keeps non-ASCII file names (ä, ö) readable instead of octal-escaped.
// Network calls also get a time limit and never prompt in a terminal nobody sees.
//
// A deployed Dot (DOT_GIT_USE_TOKEN=true) has no git login of its own, so network calls to github.com
// and bitbucket.org authenticate with DOT_GITHUB_TOKEN and DOT_BITBUCKET_TOKEN. Each token goes to that one
// git process through a credential helper, and never into a config file or an agent's environment.
export async function git(
  cwd: string,
  args: string[],
  options: { network?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DOT_")));
  if (options.network) {
    env.GIT_TERMINAL_PROMPT = "0";
    if (process.env.DOT_GIT_USE_TOKEN === "true") {
      const helpers: { url: string; username: string; password: string }[] = [];
      const github = process.env.DOT_GITHUB_TOKEN?.trim();
      if (github) helpers.push({ url: "https://github.com", username: "x-access-token", password: github });
      const bitbucket = process.env.DOT_BITBUCKET_TOKEN?.trim();
      if (bitbucket) {
        // Bitbucket wants a fixed user name for git, and which one depends on the kind of token.
        // An Atlassian API token comes with an email (DOT_BITBUCKET_EMAIL). Access tokens do not.
        const username = process.env.DOT_BITBUCKET_EMAIL?.trim() ? "x-bitbucket-api-token-auth" : "x-token-auth";
        helpers.push({ url: "https://bitbucket.org", username, password: bitbucket });
      }
      env.GIT_CONFIG_COUNT = String(helpers.length);
      helpers.forEach((h, i) => {
        env[`GIT_CONFIG_KEY_${i}`] = `credential.${h.url}.helper`;
        env[`GIT_CONFIG_VALUE_${i}`] = `!f() { echo username=${h.username}; echo "password=$DOT_GIT_PASSWORD_${i}"; }; f`;
        env[`DOT_GIT_PASSWORD_${i}`] = h.password;
      });
    }
  }
  const { stdout } = await run(
    "git",
    ["-c", "core.quotePath=false", "-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      ...(options.network ? { timeout: options.timeoutMs ?? 120_000 } : {}),
    },
  );
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function gitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim();
}

const samePath = (a: string, b: string) => {
  const rel = relative(resolve(a), resolve(b));
  return rel === "";
};

const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

export function branchSlug(taskId: number, title: string): string {
  const slug = slugOf(title);
  return `dot/${taskId}${slug ? `-${slug}` : ""}`;
}

const branchExists = (repo: string, branch: string) =>
  gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);

// True when `path` is the top of a worktree that belongs to `repo`. A folder that merely sits
// inside some other repository (Dot's own, say) does not count.
async function isWorktreeOf(path: string, repo: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const [top, common, repoCommon] = await Promise.all([
      git(path, ["rev-parse", "--show-toplevel"]),
      git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    return samePath(top.trim(), path) && samePath(common.trim(), repoCommon.trim());
  } catch {
    return false;
  }
}

// The base branch as Dot uses it. Dot fetches origin's copy into its own ref namespace, so it
// always works against the real base even when your local branch is behind (it will be, after
// Dot merges on the host), and without touching refs/remotes, which the ref audit watches.
export const dotBaseRef = (base: string) => `refs/dot/origin/${base}`;

// The freshest base Dot has: its fetched copy when one exists, otherwise your local branch.
export async function resolveBaseRef(repo: string, base: string): Promise<string> {
  const ref = dotBaseRef(base);
  return (await gitOk(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) ? ref : base;
}

// Fetches the base from origin. Returns the ref to use, plus a note when the fetch failed.
export async function fetchBase(repo: string, base: string): Promise<{ ref: string; note: string | null }> {
  if (!(await remoteUrl(repo))) return { ref: await resolveBaseRef(repo, base), note: null };
  try {
    await git(repo, ["fetch", "--no-tags", "origin", `+refs/heads/${base}:${dotBaseRef(base)}`], { network: true });
    return { ref: dotBaseRef(base), note: null };
  } catch (err) {
    const ref = await resolveBaseRef(repo, base);
    const using = ref === base ? `your local ${base}` : `the copy of ${base} it fetched earlier`;
    return { ref, note: `Could not fetch ${base} from origin, so Dot uses ${using}. ${gitError(err)}` };
  }
}

export type Workspace = { branch: string; path: string; notes: string[] };

// Creates the task's worktree, or reuses it when it is already a valid one.
// `knownBranch` says the task already owns `branch`. Otherwise an existing branch of that name
// belongs to something else (an older Dot database, say), so a fresh name is used instead.
// `worktreesDir` is Dot's own folder; only folders inside it are ever deleted.
export async function prepareWorktree(options: {
  repo: string;
  base: string;
  // What the new branch starts from: usually dotBaseRef(base), see fetchBase.
  baseRef: string;
  branch: string;
  knownBranch: boolean;
  path: string;
  worktreesDir: string;
}): Promise<Workspace> {
  const { repo, base, baseRef, path } = options;
  const notes: string[] = [];
  if (!(await gitOk(repo, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]))) {
    throw new Error(
      `The base branch "${base}" has no commits in ${repo}. Commit your work, or set the right base branch in project settings.`,
    );
  }

  let branch = options.branch;
  if (await isWorktreeOf(path, repo)) {
    const current = (await git(path, ["branch", "--show-current"])).trim();
    if (current === branch) return { branch, path, notes };
  }

  // Anything else at the path is a leftover (a folder that survived a delete, a worktree of
  // another branch). It lives in Dot's own data folder, so it is safe to clear.
  if (existsSync(path)) {
    if (relative(resolve(options.worktreesDir), resolve(path)).startsWith("..")) {
      throw new Error(`Refusing to clear ${path}: it is outside Dot's worktrees folder.`);
    }
    await gitOk(repo, ["worktree", "remove", "--force", path]);
    rmSync(path, { recursive: true, force: true });
  }
  await gitOk(repo, ["worktree", "prune"]);

  if (await branchExists(repo, branch)) {
    if (options.knownBranch) {
      await git(repo, ["worktree", "add", path, branch]);
    } else {
      const taken = branch;
      let n = 2;
      while (await branchExists(repo, `${taken}-${n}`)) n++;
      branch = `${taken}-${n}`;
      notes.push(`A branch named ${taken} already existed and isn't this task's, so the executor uses ${branch}.`);
      await git(repo, ["worktree", "add", "-b", branch, path, baseRef]);
    }
  } else {
    await git(repo, ["worktree", "add", "-b", branch, path, baseRef]);
  }

  if ((await git(repo, ["status", "--porcelain"])).trim()) {
    notes.push(
      `Your main checkout has uncommitted changes. They are not in the executor's worktree, which starts from ${base}.`,
    );
  }
  return { branch, path, notes };
}

// Removes the worktree folder. The branch stays, so no committed work is lost.
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await gitOk(repo, ["worktree", "remove", "--force", path]);
  await gitOk(repo, ["worktree", "prune"]);
}

export async function uncommittedChanges(worktree: string): Promise<string> {
  return (await git(worktree, ["status", "--porcelain"])).trim();
}

export async function commitsAhead(worktree: string, base: string): Promise<Commit[]> {
  const out = (await git(worktree, ["log", "--no-color", "--format=%h%x09%s", `${base}..HEAD`])).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

// Every ref in the repository plus what the main checkout has checked out, as "name -> value".
// The executor's shell can't be fully fenced in, so Dot compares snapshots taken before and after
// it works, and flags any change outside the task's own branch.
export type RefSnapshot = Map<string, string>;

export async function snapshotRefs(repo: string): Promise<RefSnapshot> {
  const refs: RefSnapshot = new Map();
  const out = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) refs.set(line.slice(0, space), line.slice(space + 1));
  }
  // The main checkout's HEAD shows a checkout or switch there.
  refs.set("HEAD (main checkout)", (await git(repo, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim());
  return refs;
}

// `expectedBranches` are branches Dot itself works on: this task's, and other tasks' in the same
// repository (their own executors commit to them, and the merge step pushes and deletes them).
// Changes to those, locally or as remote-tracking refs, are expected. Anything else is reported.
export function refChanges(before: RefSnapshot, after: RefSnapshot, expectedBranches: string[]): string[] {
  const expected = new Set(expectedBranches);
  const isExpected = (ref: string) => {
    // Dot's own namespace: the fetched base branch (see dotBaseRef).
    if (ref.startsWith("refs/dot/")) return true;
    const local = /^refs\/heads\/(.+)$/.exec(ref);
    if (local && expected.has(local[1]!)) return true;
    const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
    return Boolean(remote && expected.has(remote[1]!));
  };
  const changes: string[] = [];
  for (const [name, value] of after) {
    if (isExpected(name)) continue;
    const old = before.get(name);
    if (old === undefined) changes.push(`created ${name}`);
    else if (old !== value) changes.push(`moved ${name}`);
  }
  for (const name of before.keys()) {
    if (!isExpected(name) && !after.has(name)) changes.push(`deleted ${name}`);
  }
  return changes;
}

// Merge step helpers. All run in your main repository, with your git credentials.

export async function branchHead(repo: string, branch: string): Promise<string> {
  return (await git(repo, ["rev-parse", `refs/heads/${branch}`])).trim();
}

// True when the file exists at that commit. Reads the object store only, so no checkout is needed.
export async function fileAtCommit(repo: string, commit: string, path: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${commit}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

export async function remoteUrl(repo: string, remote = "origin"): Promise<string | null> {
  try {
    return (await git(repo, ["remote", "get-url", remote])).trim();
  } catch {
    return null;
  }
}

// Clones a repository into `dest`. Returns the branch the clone checked out, which is the host's default.
export async function cloneRepo(url: string, dest: string): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    await git(dirname(dest), ["clone", url, dest], { network: true, timeoutMs: 15 * 60_000 });
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return (await git(dest, ["branch", "--show-current"])).trim();
}

export async function branchExistsLocally(repo: string, branch: string): Promise<boolean> {
  return branchExists(repo, branch);
}

export async function pushBranch(repo: string, branch: string, remote = "origin"): Promise<void> {
  await git(repo, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`], { network: true });
}

// Files that would conflict when merging `branch` into `base`, computed in memory with
// git merge-tree. No checkout is touched. Empty means it merges cleanly.
export async function mergeConflicts(repo: string, base: string, branch: string): Promise<string[]> {
  try {
    await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch]);
    return [];
  } catch (err) {
    // Exit code 1 means conflicts. Output: the tree id, then one conflicted path per line.
    const e = err as { code?: number; stdout?: string };
    if (e.code !== 1 || typeof e.stdout !== "string") throw err;
    return e.stdout.trim().split("\n").slice(1).filter(Boolean);
  }
}

// After a squash merge the branch is not an ancestor of the base, so -D is needed. Only called
// once the host reports the pull request merged.
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await gitOk(repo, ["branch", "-D", branch]);
  // The push left a remote-tracking ref behind. The merge removed the branch, so drop it too.
  await gitOk(repo, ["update-ref", "-d", `refs/remotes/origin/${branch}`]);
}

const MAX_FILE_PATCH = 100_000;
const MAX_TOTAL_PATCH = 600_000;

// `baseRef` is what the diff is computed against (see resolveBaseRef). `base` is the branch name to show.
export async function branchDiff(worktree: string, baseRef: string, branch: string, base: string): Promise<TaskDiff> {
  const range = `${baseRef}...HEAD`;
  const [numstat, patch, commits, dirty] = await Promise.all([
    git(worktree, ["diff", "--numstat", "-M", "--no-ext-diff", "-z", range]),
    git(worktree, ["diff", "--no-color", "--no-ext-diff", "-M", range]),
    commitsAhead(worktree, baseRef),
    uncommittedChanges(worktree),
  ]);

  // With -z, each entry is "adds\tdels\tpath\0". A rename is "adds\tdels\t\0old\0new\0" instead.
  // Binary files show "-" for both counts.
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const tokens = numstat.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const parts = tokens[i]!.split("\t");
    if (parts.length !== 3) continue;
    let path = parts[2]!;
    if (path === "") {
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    counts.set(path, {
      additions: parts[0] === "-" ? 0 : Number(parts[0]),
      deletions: parts[1] === "-" ? 0 : Number(parts[1]),
      binary: parts[0] === "-",
    });
  }

  const files: DiffFile[] = [];
  let budget = MAX_TOTAL_PATCH;
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const header = chunk.slice(0, chunk.indexOf("\n"));
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    const renamedFrom = /^rename from (.+)$/m.exec(chunk)?.[1] ?? null;
    const renamedTo = /^rename to (.+)$/m.exec(chunk)?.[1] ?? null;
    const path = renamedTo ?? match?.[2] ?? header.slice(11);
    const stat = counts.get(path);
    const binary = stat?.binary ?? /^Binary files /m.test(chunk);

    const limit = Math.min(MAX_FILE_PATCH, budget);
    const truncated = chunk.length > limit;
    const body = truncated ? chunk.slice(0, Math.max(0, limit)) : chunk;
    budget -= body.length;

    files.push({
      path,
      oldPath: renamedFrom,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary,
      patch: binary ? "" : body,
      truncated,
    });
  }

  return { base, branch, commits, files, dirty: dirty !== "" };
}
