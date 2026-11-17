// A small GitHub REST API client for the merge step.
// Credentials come from Dot's .env and are never passed to agents or git.
//   DOT_GITHUB_TOKEN  fine-grained or classic personal access token (Bearer)
//   DOT_GITHUB_API    API base URL, for GitHub Enterprise or testing against a fake server

import type { BuildStatus, PullRequest } from "./bitbucket.ts";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type RawPullRequest = { number: number; state: string; merged_at?: string | null; html_url?: string };

// Bitbucket's state names, so the merge step reads both hosts the same way.
const toPullRequest = (pr: RawPullRequest): PullRequest => ({
  id: pr.number,
  state: pr.merged_at ? "MERGED" : pr.state === "open" ? "OPEN" : "DECLINED",
  url: pr.html_url ?? "",
});

type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  output?: { title?: string | null; summary?: string | null; text?: string | null };
};

type CommitStatus = { context: string; state: string; target_url?: string | null; description?: string | null };

// Check runs (GitHub Actions and apps) and commit statuses (older CI services) both count as builds.
function checkRunState(run: CheckRun): BuildStatus["state"] {
  if (run.status !== "completed") return "INPROGRESS";
  switch (run.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "SUCCESSFUL";
    case "cancelled":
    case "stale":
      return "STOPPED";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "FAILED";
    default:
      // An unknown conclusion keeps the merge step waiting rather than guessing.
      return run.conclusion ?? "INPROGRESS";
  }
}

function commitStatusState(status: CommitStatus): BuildStatus["state"] {
  switch (status.state) {
    case "success":
      return "SUCCESSFUL";
    case "failure":
    case "error":
      return "FAILED";
    case "pending":
      return "INPROGRESS";
    default:
      return status.state;
  }
}

export class GitHub {
  private constructor(
    private readonly token: string,
    private readonly base: string,
  ) {}

  // Null when no token is configured. The merge step then explains what to set.
  static fromEnv(): GitHub | null {
    const token = process.env.DOT_GITHUB_TOKEN?.trim();
    if (!token) return null;
    const base = (process.env.DOT_GITHUB_API?.trim() || "https://api.github.com").replace(/\/$/, "");
    return new GitHub(token, base);
  }

  // Repositories the token can push to, most recently pushed first, for the new-project picker.
  async listRepos(): Promise<{ fullName: string; defaultBranch: string; private: boolean }[]> {
    const repos = await this.request<{ full_name: string; default_branch: string; private: boolean; permissions?: { push?: boolean } }[]>(
      "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
    );
    return repos
      .filter((r) => r.permissions?.push !== false)
      .map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private }));
  }

  async getRepo(owner: string, name: string): Promise<{ defaultBranch: string }> {
    const repo = await this.request<{ default_branch: string }>(`/repos/${owner}/${name}`);
    return { defaultBranch: repo.default_branch };
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dot-merge-step",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
      const detail = [data?.message, ...(data?.errors ?? []).map((e) => e.message)]
        .filter(Boolean)
        .join(": ")
        .replace(/\.+$/, "");
      const hint =
        res.status === 401 || res.status === 403 || res.status === 404
          ? " Check DOT_GITHUB_TOKEN and that it can reach this repository with Contents, Pull requests, Checks and Commit statuses access."
          : "";
      throw new GitHubError(res.status, `GitHub ${res.status}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private repo(owner: string, name: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  async findOpenPullRequest(owner: string, name: string, branch: string): Promise<PullRequest | null> {
    const head = encodeURIComponent(`${owner}:${branch}`);
    const data = await this.request<RawPullRequest[]>(`${this.repo(owner, name)}/pulls?state=open&head=${head}`);
    const pr = data[0];
    return pr ? toPullRequest(pr) : null;
  }

  async createPullRequest(
    owner: string,
    name: string,
    input: { title: string; description: string; source: string; destination: string },
  ): Promise<PullRequest> {
    const pr = await this.request<RawPullRequest>(`${this.repo(owner, name)}/pulls`, {
      method: "POST",
      body: { title: input.title, body: input.description, head: input.source, base: input.destination },
    });
    return toPullRequest(pr);
  }

  async getPullRequest(owner: string, name: string, id: number): Promise<PullRequest> {
    return toPullRequest(await this.request<RawPullRequest>(`${this.repo(owner, name)}/pulls/${id}`));
  }

  private async checkRuns(owner: string, name: string, commit: string): Promise<CheckRun[]> {
    const data = await this.request<{ check_runs: CheckRun[] }>(
      `${this.repo(owner, name)}/commits/${encodeURIComponent(commit)}/check-runs?per_page=100`,
    );
    return data.check_runs;
  }

  async buildStatuses(owner: string, name: string, commit: string): Promise<BuildStatus[]> {
    const [runs, combined] = await Promise.all([
      this.checkRuns(owner, name, commit),
      this.request<{ statuses: CommitStatus[] }>(
        `${this.repo(owner, name)}/commits/${encodeURIComponent(commit)}/status?per_page=100`,
      ),
    ]);
    return [
      ...runs.map((r) => ({ state: checkRunState(r), key: r.name, name: r.name, url: r.html_url ?? "" })),
      ...combined.statuses.map((s) => ({
        state: commitStatusState(s),
        key: s.context,
        name: s.context,
        url: s.target_url ?? "",
      })),
    ];
  }

  // Squash merges the pull request, then deletes the remote branch. GitHub only deletes it by itself
  // when the repository has "Automatically delete head branches" turned on.
  async squashMerge(owner: string, name: string, id: number, message: string, branch: string): Promise<void> {
    const [title, ...rest] = message.split("\n");
    try {
      await this.request(`${this.repo(owner, name)}/pulls/${id}/merge`, {
        method: "PUT",
        body: { merge_method: "squash", commit_title: `${title} (#${id})`, commit_message: rest.join("\n").trim() },
      });
    } catch (err) {
      // 405 means branch protection or another merge rule said no. 409 means the branch moved.
      if (err instanceof GitHubError && (err.status === 405 || err.status === 409 || err.status === 422)) {
        throw new GitHubError(
          err.status,
          `GitHub refused the merge. Check the pull request's branch protection rules, such as required reviews, then press Retry merge. (${err.message})`,
        );
      }
      throw err;
    }
    try {
      await this.request(`${this.repo(owner, name)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, {
        method: "DELETE",
      });
    } catch (err) {
      // 422 means GitHub already deleted it. Anything else leaves a stale branch, which is harmless.
      if (!(err instanceof GitHubError && err.status === 422)) console.error(`Could not delete ${branch} on GitHub:`, err);
    }
  }

  // How many GitHub Actions workflows the repository has, or null when GitHub won't say.
  async workflowCount(owner: string, name: string): Promise<number | null> {
    try {
      const data = await this.request<{ total_count: number }>(`${this.repo(owner, name)}/actions/workflows?per_page=1`);
      return data.total_count;
    } catch {
      return null;
    }
  }

  // The failed checks' own reports for this commit. GitHub Actions keeps full logs in zip files,
  // so this uses the summary and text each check run publishes. Best effort.
  async failedBuildLog(owner: string, name: string, commit: string, lines = 120): Promise<string | null> {
    try {
      const failed = (await this.checkRuns(owner, name, commit)).filter((r) => checkRunState(r) === "FAILED");
      const parts = failed
        .map((r) => {
          const body = [r.output?.title, r.output?.summary, r.output?.text].filter(Boolean).join("\n\n").trim();
          return body ? `Check "${r.name}":\n${body.split("\n").slice(-lines).join("\n")}` : "";
        })
        .filter(Boolean);
      return parts.length > 0 ? parts.join("\n\n") : null;
    } catch {
      return null;
    }
  }
}
