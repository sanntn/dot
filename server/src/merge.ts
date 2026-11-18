import type { Task } from "@dot/shared";
import type { BuildStatus } from "./bitbucket.ts";
import { HttpError } from "./errors.ts";
import { repoHostFor, trustedOrigin, type RepoHostClient } from "./githost.ts";
import { deleteBranch, fetchBase, gitError, mergeConflicts, pushBranch, remoteUrl, removeWorktree } from "./git.ts";
import type { Store } from "./store.ts";

// Merge step. Plain code, no agent: conflict check, push, pull request, wait for CI,
// squash merge, clean up. Every step can safely run again, so Retry and restart recovery
// just run the whole job from the top.

export type MergeHooks = {
  publish: (taskId: number) => void;
  // Stops the task's agents. Resolves once their processes have exited.
  stop: (taskId: number) => Promise<void>;
  // Sends a prompt to the executor's existing session, as a new fix cycle.
  resumeExecutor: (runId: number, prompt: string) => void;
};

export class MergeStep {
  private readonly running = new Map<number, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly hooks: MergeHooks,
  ) {}

  isRunning(taskId: number): boolean {
    return this.running.has(taskId);
  }

  // A running merge stops at its next step. Host API calls already sent still finish.
  abort(taskId: number): void {
    this.running.get(taskId)?.abort();
  }

  // Picks a merge up again from the top, after a restart.
  resume(taskId: number): void {
    void this.run(taskId, false);
  }

  async start(taskId: number, options: { skipCi: boolean }): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.column !== "merge_approval" && task.column !== "merge") {
      throw new HttpError(409, "Only a task in Merge approval can be merged");
    }
    if (this.running.has(taskId)) throw new HttpError(409, "The merge is already running");
    // Fails early with what to set when the host, repo or token is missing.
    await repoHostFor(this.store.getProject(task.projectId));
    if (!task.branch) throw new HttpError(409, "This task has no branch to merge");

    // A chat with a past-stage agent may still be running in the worktree the merge removes at the end.
    this.running.set(taskId, new AbortController());
    try {
      await this.hooks.stop(taskId);
    } finally {
      this.running.delete(taskId);
    }

    if (task.column === "merge_approval") {
      this.store.moveTask(taskId, { column: "merge", beforeTaskId: null });
      this.store.addMessage({ taskId, runId: null, role: "system", kind: "status", text: "You approved the merge." });
    }
    this.store.setNeedsInput(taskId, false);
    this.store.setAgentState(taskId, "running");
    this.hooks.publish(taskId);
    void this.run(taskId, options.skipCi);
    return this.store.getTask(taskId);
  }

  private async run(taskId: number, skipCi: boolean): Promise<void> {
    const abort = new AbortController();
    this.running.set(taskId, abort);
    const say = (text: string, kind: "status" | "error" = "status") => {
      this.store.addMessage({ taskId, runId: null, role: "system", kind, text });
      this.hooks.publish(taskId);
    };
    const stillMerging = () => {
      if (abort.signal.aborted) throw new Error("aborted");
    };

    try {
      const task = this.store.getTask(taskId);
      const project = this.store.getProject(task.projectId);
      const remote = await repoHostFor(project);
      const branch = task.branch!;
      const repo = project.repoPath;
      const base = project.baseBranch;

      // 0. Already merged? Happens when Dot restarted after the host merged but before cleanup.
      //    Pushing or opening a pull request again would recreate the closed branch.
      const knownPr = task.prId ? await remote.getPullRequest(task.prId) : null;
      if (knownPr?.state === "MERGED") {
        say(`Pull request #${knownPr.id} is already merged. Finishing up.`);
        await this.finish(taskId, knownPr.id);
        return;
      }

      // 1. Would the branch still merge cleanly into origin's current base?
      const fetched = await fetchBase(repo, base, trustedOrigin(project));
      if (fetched.note) say(fetched.note);
      const conflicts = await mergeConflicts(repo, fetched.ref, branch);
      stillMerging();
      if (conflicts.length > 0) {
        const files = conflicts.map((f) => `- ${f}`).join("\n");
        this.sendToExecutor(
          taskId,
          `The base branch ${base} has moved on and now conflicts with your branch in these files:\n\n${files}\n\n` +
            `Merge it into your branch (git merge ${fetched.ref}), resolve the conflicts, rerun the project's checks, ` +
            "commit, and call submit_execution_report. The work goes through review again before it can merge.",
          `${base} now conflicts with ${branch} in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}, so the task went back to the executor to merge ${base} in.`,
        );
        return;
      }

      // 2. Push with your git credentials.
      const origin = await remoteUrl(repo);
      if (!origin) throw new Error(`The repository has no "origin" remote to push to.`);
      const fullName = `${remote.owner}/${remote.name}`;
      const originNote = `Note: origin is ${origin}, which doesn't look like ${remote.label} repo ${fullName} from the project settings.`;
      if (!origin.toLowerCase().includes(fullName.toLowerCase()) && !this.store.listMessages(taskId).some((m) => m.text === originNote)) {
        say(originNote);
      }
      say(`Pushing ${branch} to origin.`);
      // The commit that was pushed, so the build wait and the merge refer to exactly that commit.
      const head = await pushBranch(repo, branch, { origin: trustedOrigin(project), base });
      stillMerging();

      // 3. Reuse the task's pull request while it is open, otherwise find or open one.
      let pr = knownPr?.state === "OPEN" ? knownPr : null;
      pr ??= await remote.findOpenPullRequest(branch);
      if (!pr) {
        pr = await remote.createPullRequest({
          title: task.title,
          description: this.pullRequestDescription(taskId),
          source: branch,
          destination: base,
        });
        say(`Opened pull request #${pr.id}: ${pr.url}`);
      }
      this.store.setPullRequest(taskId, pr.id, pr.url || null);
      this.hooks.publish(taskId);
      stillMerging();

      // 4. Wait for CI.
      if (!skipCi) {
        // A repository without CI never reports a build, so waiting the full no-CI time only
        // delays the merge. When the host's own CI isn't set up (no Pipelines or Actions config
        // on the branch, and none in the repository), Dot waits briefly in case another CI
        // service reports, then merges.
        const noPipelines = await remote.hasNoCi(repo, head);
        stillMerging();
        say(
          noPipelines
            ? `This repository has no ${remote.ciName}. Checking briefly whether any other CI reports a build for ${head.slice(0, 12)}.`
            : `Waiting for the build of ${head.slice(0, 12)}.`,
        );
        const outcome = await this.waitForBuilds(remote, head, abort.signal, noPipelines);
        if (outcome.kind === "none" && noPipelines) {
          say("No CI reported a build, so there is nothing to wait for.");
        } else if (outcome.kind === "none") {
          this.store.setNeedsInput(taskId, true);
          this.store.setAgentState(taskId, "waiting");
          say(
            "No build status showed up for this commit. If the repository has no CI, use Merge without CI. " +
              `Otherwise check ${remote.label} and press Retry merge.`,
          );
          return;
        } else if (outcome.kind === "failed") {
          const log = await remote.failedBuildLog(head);
          const failures = outcome.statuses.map((s) => `- ${s.name || s.key}: ${s.state} ${s.url}`).join("\n");
          this.sendToExecutor(
            taskId,
            `The ${remote.label} build failed for your branch:\n\n${failures}` +
              (log ? `\n\nWhat the failed build reported:\n\n${log}` : "") +
              "\n\nFix the cause, commit, and call submit_execution_report. The work goes through review again before it can merge.",
            `The build failed, so the task went back to the executor.\n\n${failures}`,
          );
          return;
        } else {
          say("The build passed.");
        }
      }
      stillMerging();

      // 5. Squash merge.
      say(`Merging pull request #${pr.id} (squash).`);
      await remote.squashMerge(pr.id, this.squashMessage(taskId), branch);

      // 6. Done.
      await this.finish(taskId, pr.id);
    } catch (err) {
      if (abort.signal.aborted) {
        say("Merge stopped.");
        this.store.setAgentState(taskId, "idle");
        return;
      }
      this.store.setNeedsInput(taskId, true);
      this.store.setAgentState(taskId, "failed");
      say(`The merge stopped: ${err instanceof Error ? err.message : gitError(err)}`, "error");
    } finally {
      this.running.delete(taskId);
      this.hooks.publish(taskId);
    }
  }

  // The pull request is merged: move the task to Done and remove the worktree, the local branch
  // and its remote-tracking ref. The merge removed the branch on the host.
  private async finish(taskId: number, prId: number): Promise<void> {
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    this.store.moveTask(taskId, { column: "done", beforeTaskId: null });
    this.store.setAgentState(taskId, "idle");
    this.store.addMessage({
      taskId,
      runId: null,
      role: "system",
      kind: "status",
      text: `Merged pull request #${prId} into ${project.baseBranch}.`,
    });
    this.hooks.publish(taskId);
    if (task.worktreePath) await removeWorktree(project.repoPath, task.worktreePath);
    if (task.branch) {
      await deleteBranch(project.repoPath, task.branch);
      this.store.setTaskWorkspace(taskId, task.branch, null);
    }
  }

  // Polls the commit's build statuses. "none" when no status shows up at all for a while,
  // which usually means the repository has no CI.
  private async waitForBuilds(
    remote: RepoHostClient,
    commit: string,
    signal: AbortSignal,
    noPipelines: boolean,
  ): Promise<{ kind: "passed" } | { kind: "none" } | { kind: "failed"; statuses: BuildStatus[] }> {
    const pollMs = Number(process.env.DOT_MERGE_POLL_MS ?? 15_000);
    const configuredNoneAfterMs = Number(process.env.DOT_MERGE_NO_CI_MS ?? 5 * 60_000);
    const noneAfterMs = noPipelines ? Math.min(configuredNoneAfterMs, 30_000) : configuredNoneAfterMs;
    const giveUpMs = 60 * 60_000;
    const started = Date.now();
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const statuses = await remote.buildStatuses(commit);
      const elapsed = Date.now() - started;
      // Only these states are final. Anything else, including a state Dot doesn't know, means
      // keep waiting: merging must never happen on a guess.
      const finished = (s: BuildStatus) => s.state === "SUCCESSFUL" || s.state === "FAILED" || s.state === "STOPPED";
      if (statuses.length === 0) {
        if (elapsed > noneAfterMs) return { kind: "none" };
      } else if (statuses.every(finished)) {
        const failed = statuses.filter((s) => s.state !== "SUCCESSFUL");
        return failed.length > 0 ? { kind: "failed", statuses: failed } : { kind: "passed" };
      }
      if (elapsed > giveUpMs) throw new Error("The build didn't finish within an hour.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // Sends merge-time problems (conflicts, a red build) back to the executor as a new fix cycle.
  private sendToExecutor(taskId: number, prompt: string, note: string): void {
    const run = this.store.latestRun(taskId, "execute");
    this.store.addMessage({ taskId, runId: null, role: "system", kind: "error", text: note });
    if (!run) {
      this.store.setNeedsInput(taskId, true);
      this.store.setAgentState(taskId, "failed");
      this.hooks.publish(taskId);
      return;
    }
    this.store.moveTask(taskId, { column: "execute", beforeTaskId: null });
    this.store.setReviewRound(taskId, 0);
    this.store.setAgentState(taskId, "idle");
    this.hooks.resumeExecutor(run.id, prompt);
    this.hooks.publish(taskId);
  }

  private pullRequestDescription(taskId: number): string {
    const task = this.store.getTask(taskId);
    const plan = this.store.latestPlan(taskId)?.plan;
    const reports = this.store.listExecutionReports(taskId);
    const review = this.store.latestReview(taskId);
    const section = (title: string, body: string | undefined) => (body?.trim() ? `## ${title}\n\n${body.trim()}` : "");
    // The first report describes the change. Later ones are fix rounds, listed after it.
    const [first, ...later] = reports;
    const changed = first
      ? [first.report.summary, ...later.map((r) => `Fix round: ${r.report.summary}`)].join("\n\n")
      : undefined;
    return [
      task.description.trim(),
      section("Goal", plan?.goal),
      section("Acceptance criteria", plan?.acceptanceCriteria.map((c) => `- ${c}`).join("\n")),
      section("What changed", changed),
      section("Review", review ? `${review.review.summary}\n\nApproved in review round ${review.version}.` : undefined),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private squashMessage(taskId: number): string {
    const task = this.store.getTask(taskId);
    const goal = this.store.latestPlan(taskId)?.plan.goal;
    return goal ? `${task.title}\n\n${goal}` : task.title;
  }
}
