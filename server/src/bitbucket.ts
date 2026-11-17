// A small Bitbucket Cloud REST API 2.0 client for the merge step.
// Credentials come from Dot's .env and are never passed to agents or git.
//   DOT_BITBUCKET_EMAIL + DOT_BITBUCKET_TOKEN  Atlassian API token (Basic auth with your Atlassian email)
//   DOT_BITBUCKET_TOKEN alone                  repository or workspace access token (Bearer)
//   DOT_BITBUCKET_API                          API base URL, only for testing against a fake server

export class BitbucketError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type PullRequest = { id: number; url: string; state: string };

// Bitbucket documents these four states. The type stays open, since the merge step must treat
// any other value as "not finished" rather than assume.
export type BuildStatus = {
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED" | (string & {});
  key: string;
  name: string;
  url: string;
};

type RawPullRequest = { id: number; state: string; links?: { html?: { href?: string } } };

const toPullRequest = (pr: RawPullRequest): PullRequest => ({
  id: pr.id,
  state: pr.state,
  url: pr.links?.html?.href ?? "",
});

export class Bitbucket {
  private constructor(
    private readonly authorization: string,
    private readonly base: string,
  ) {}

  // Null when no token is configured. The merge step then explains what to set.
  static fromEnv(): Bitbucket | null {
    const token = process.env.DOT_BITBUCKET_TOKEN?.trim();
    if (!token) return null;
    const email = process.env.DOT_BITBUCKET_EMAIL?.trim();
    const authorization = email
      ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
      : `Bearer ${token}`;
    const base = (process.env.DOT_BITBUCKET_API?.trim() || "https://api.bitbucket.org/2.0").replace(/\/$/, "");
    return new Bitbucket(authorization, base);
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; text?: boolean } = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: this.authorization,
        Accept: init.text ? "text/plain" : "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string; detail?: string } } | null;
      const detail = [data?.error?.message, data?.error?.detail].filter(Boolean).join(": ").replace(/\.+$/, "");
      const hint =
        res.status === 401 || res.status === 403
          ? " Check DOT_BITBUCKET_TOKEN (and DOT_BITBUCKET_EMAIL for an Atlassian API token) and the token's scopes."
          : "";
      throw new BitbucketError(res.status, `Bitbucket ${res.status}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    if (res.status === 204) return undefined as T;
    return (init.text ? await res.text() : await res.json()) as T;
  }

  private repo(workspace: string, slug: string): string {
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
  }

  async findOpenPullRequest(workspace: string, slug: string, branch: string): Promise<PullRequest | null> {
    const q = encodeURIComponent(`source.branch.name="${branch.replace(/"/g, '\\"')}" AND state="OPEN"`);
    const data = await this.request<{ values: RawPullRequest[] }>(`${this.repo(workspace, slug)}/pullrequests?q=${q}`);
    const pr = data.values[0];
    return pr ? toPullRequest(pr) : null;
  }

  async createPullRequest(
    workspace: string,
    slug: string,
    input: { title: string; description: string; source: string; destination: string },
  ): Promise<PullRequest> {
    const pr = await this.request<RawPullRequest>(`${this.repo(workspace, slug)}/pullrequests`, {
      method: "POST",
      body: {
        title: input.title,
        description: input.description,
        source: { branch: { name: input.source } },
        destination: { branch: { name: input.destination } },
        close_source_branch: true,
      },
    });
    return toPullRequest(pr);
  }

  async getPullRequest(workspace: string, slug: string, id: number): Promise<PullRequest> {
    return toPullRequest(await this.request<RawPullRequest>(`${this.repo(workspace, slug)}/pullrequests/${id}`));
  }

  async buildStatuses(workspace: string, slug: string, commit: string): Promise<BuildStatus[]> {
    const data = await this.request<{ values: BuildStatus[] }>(
      `${this.repo(workspace, slug)}/commit/${encodeURIComponent(commit)}/statuses?pagelen=100`,
    );
    return data.values;
  }

  // Squash merges the pull request. Bitbucket answers 202 for merges it finishes in the background,
  // so this waits for the pull request to show as merged.
  async squashMerge(workspace: string, slug: string, id: number, message: string): Promise<void> {
    try {
      await this.request(`${this.repo(workspace, slug)}/pullrequests/${id}/merge`, {
        method: "POST",
        body: { type: "pullrequest", merge_strategy: "squash", close_source_branch: true, message },
      });
    } catch (err) {
      // Repositories often require approvals or other merge checks. Say so plainly.
      if (err instanceof BitbucketError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403) {
        throw new BitbucketError(
          err.status,
          `Bitbucket refused the merge. Check the pull request's merge checks, such as required approvals, then press Retry merge. (${err.message})`,
        );
      }
      throw err;
    }
    for (let i = 0; i < 40; i++) {
      const pr = await this.getPullRequest(workspace, slug, id);
      if (pr.state === "MERGED") return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new BitbucketError(504, "Bitbucket accepted the merge but the pull request did not show as merged within two minutes.");
  }

  // How many Pipelines runs the repository has ever had, or null when Bitbucket won't say.
  // The pipelines_config endpoint would answer "enabled?" directly, but it needs repository:admin.
  async pipelineRunCount(workspace: string, slug: string): Promise<number | null> {
    try {
      const data = await this.request<{ size?: number; values: unknown[] }>(
        `${this.repo(workspace, slug)}/pipelines/?pagelen=1`,
      );
      return data.size ?? data.values.length;
    } catch {
      return null;
    }
  }

  // The last lines of the failed step's log for the pipeline that built this commit.
  // Best effort: returns null when the pipeline or its log can't be found.
  async failedPipelineLog(workspace: string, slug: string, commit: string, lines = 120): Promise<string | null> {
    try {
      const repo = this.repo(workspace, slug);
      const pipelines = await this.request<{
        values: { uuid: string; target?: { commit?: { hash?: string } } }[];
      }>(`${repo}/pipelines/?sort=-created_on&pagelen=30`);
      const pipeline = pipelines.values.find((p) => p.target?.commit?.hash?.startsWith(commit.slice(0, 12)));
      if (!pipeline) return null;
      const steps = await this.request<{
        values: { uuid: string; name?: string; state?: { result?: { name?: string } } }[];
      }>(`${repo}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps/`);
      const failed = steps.values.find((s) => s.state?.result?.name === "FAILED");
      if (!failed) return null;
      const log = await this.request<string>(
        `${repo}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps/${encodeURIComponent(failed.uuid)}/log`,
        { text: true },
      );
      const tail = log.split("\n").slice(-lines).join("\n");
      return `Step "${failed.name ?? "unnamed"}":\n${tail}`;
    } catch {
      return null;
    }
  }
}
