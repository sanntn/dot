// Picks the pull request host for a project: Bitbucket or GitHub, read from the origin remote
// unless the project settings say otherwise. The merge step talks to both through RepoHostClient.

import { REPO_HOST_LABELS, type Project, type RemoteInfo, type RepoHost } from "@dot/shared";
import { Bitbucket, type BuildStatus, type PullRequest } from "./bitbucket.ts";
import { HttpError } from "./errors.ts";
import { GitHub } from "./github.ts";
import { fileAtCommit, remoteUrl } from "./git.ts";

// Reads host, owner and repo from a remote URL. Handles the forms git accepts:
//   https://[user@]bitbucket.org/owner/repo.git
//   ssh://git@github.com[:port]/owner/repo.git
//   git@github.com:owner/repo.git
// The host counts as GitHub or Bitbucket when its name contains "github" or "bitbucket", so SSH
// aliases like github-work and GitHub Enterprise hosts work too.
export function parseRemoteUrl(url: string): Omit<RemoteInfo, "url"> {
  const trimmed = url.trim();
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed) ??
    /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  const hostname = match?.[1] ?? null;
  const path = match?.[2] ?? "";

  const segments = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  const host = hostname?.toLowerCase() ?? "";
  return {
    host: host.includes("github") ? "github" : host.includes("bitbucket") ? "bitbucket" : null,
    owner: segments.length >= 2 ? segments[segments.length - 2]! : null,
    name: segments.length >= 2 ? segments[segments.length - 1]! : null,
  };
}

// Where Dot fetches from and pushes to in an isolated Dot, built only from the project's own fields.
// The repository's origin config is not used, since an agent can edit it. Null when the project
// does not name a GitHub or Bitbucket repository.
export function trustedOrigin(project: Project): string | null {
  const { repoHost, repoOwner, repoName } = project;
  const plain = /^[\w.-]+$/;
  if (!repoHost || !repoOwner || !repoName || !plain.test(repoOwner) || !plain.test(repoName)) return null;
  return `https://${repoHost === "bitbucket" ? "bitbucket.org" : "github.com"}/${repoOwner}/${repoName}.git`;
}

export async function detectRemote(repoPath: string): Promise<RemoteInfo> {
  const url = await remoteUrl(repoPath);
  if (!url) return { url: null, host: null, owner: null, name: null };
  return { url, ...parseRemoteUrl(url) };
}

export interface RepoHostClient {
  readonly host: RepoHost;
  readonly label: string;
  // What the host calls its own CI, for messages.
  readonly ciName: string;
  readonly owner: string;
  readonly name: string;
  findOpenPullRequest(branch: string): Promise<PullRequest | null>;
  createPullRequest(input: { title: string; description: string; source: string; destination: string }): Promise<PullRequest>;
  getPullRequest(id: number): Promise<PullRequest>;
  buildStatuses(commit: string): Promise<BuildStatus[]>;
  // Squash merges and makes sure the remote branch is gone afterwards.
  squashMerge(id: number, message: string, branch: string): Promise<void>;
  // True when the host's own CI is clearly not set up for this commit, so no build will report.
  hasNoCi(repoPath: string, commit: string): Promise<boolean>;
  failedBuildLog(commit: string): Promise<string | null>;
}

function bitbucketClient(api: Bitbucket, owner: string, name: string): RepoHostClient {
  return {
    host: "bitbucket",
    label: "Bitbucket",
    ciName: "Pipelines",
    owner,
    name,
    findOpenPullRequest: (branch) => api.findOpenPullRequest(owner, name, branch),
    createPullRequest: (input) => api.createPullRequest(owner, name, input),
    getPullRequest: (id) => api.getPullRequest(owner, name, id),
    buildStatuses: (commit) => api.buildStatuses(owner, name, commit),
    // close_source_branch removes the branch on Bitbucket.
    squashMerge: (id, message) => api.squashMerge(owner, name, id, message),
    hasNoCi: async (repoPath, commit) =>
      !(await fileAtCommit(repoPath, commit, "bitbucket-pipelines.yml")) &&
      (await api.pipelineRunCount(owner, name)) === 0,
    failedBuildLog: (commit) => api.failedPipelineLog(owner, name, commit),
  };
}

function githubClient(api: GitHub, owner: string, name: string): RepoHostClient {
  return {
    host: "github",
    label: "GitHub",
    ciName: "GitHub Actions",
    owner,
    name,
    findOpenPullRequest: (branch) => api.findOpenPullRequest(owner, name, branch),
    createPullRequest: (input) => api.createPullRequest(owner, name, input),
    getPullRequest: (id) => api.getPullRequest(owner, name, id),
    buildStatuses: (commit) => api.buildStatuses(owner, name, commit),
    squashMerge: (id, message, branch) => api.squashMerge(owner, name, id, message, branch),
    // Actions runs only workflows in .github/workflows on the pushed commit.
    hasNoCi: async (repoPath, commit) =>
      !(await fileAtCommit(repoPath, commit, ".github/workflows")) && (await api.workflowCount(owner, name)) === 0,
    failedBuildLog: (commit) => api.failedBuildLog(owner, name, commit),
  };
}

// The client for a project's pull requests. Settings win over what origin says, field by field.
// Throws a 409 that says what to set when something is missing.
export async function repoHostFor(project: Project): Promise<RepoHostClient> {
  const needsRemote = !project.repoHost || !project.repoOwner || !project.repoName;
  const remote = needsRemote ? await detectRemote(project.repoPath) : null;
  const host = project.repoHost ?? remote?.host ?? null;
  const owner = project.repoOwner ?? remote?.owner ?? null;
  const name = project.repoName ?? remote?.name ?? null;

  if (!host) {
    throw new HttpError(
      409,
      remote?.url
        ? `Dot can't tell whether origin (${remote.url}) is on Bitbucket or GitHub. Pick the host in the project settings.`
        : `The repository has no "origin" remote. Add one, or set the host, owner and repo in the project settings.`,
    );
  }
  if (!owner || !name) {
    throw new HttpError(409, `Set the ${REPO_HOST_LABELS[host]} owner and repo in the project settings.`);
  }

  if (host === "github") {
    const api = GitHub.fromEnv();
    if (!api) throw new HttpError(409, "Set DOT_GITHUB_TOKEN in Dot's .env file first. Then restart Dot.");
    return githubClient(api, owner, name);
  }
  const api = Bitbucket.fromEnv();
  if (!api) {
    throw new HttpError(
      409,
      "Set DOT_BITBUCKET_TOKEN in Dot's .env file first, plus DOT_BITBUCKET_EMAIL if it is an Atlassian API token. Then restart Dot.",
    );
  }
  return bitbucketClient(api, owner, name);
}
