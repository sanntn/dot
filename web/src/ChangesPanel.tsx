import { reportHeadline, type DiffFile, type ExecutionArtifact, type Task, type TaskDiff } from "@dot/shared";
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, GitBranch, GitCommitHorizontal, MessageSquarePlus, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "./api.ts";
import { commentKey, commentsToNotes, lineKey, outdatedComments, parseHunks, type DiffLine, type LineComment } from "./diffComments.ts";
import { serialLoader } from "./events.ts";
import { ClampedProse, Headline, MoreDetails } from "./detail.tsx";
import { Prose } from "./Prose.tsx";

// The executor's report, the branch's commits and its diff against the base branch.
// Loads when first shown and reloads when the task changes while visible.
export function ChangesPanel({ task, active, version }: { task: Task; active: boolean; version: number }) {
  const [report, setReport] = useState<ExecutionArtifact | null>(null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Line comments are kept in this browser until you send them, so a reload does not lose them.
  const storeKey = `dot.diff-comments.${task.id}`;
  const [comments, setComments] = useState<LineComment[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) ?? "[]") as unknown;
      return Array.isArray(saved) ? (saved as LineComment[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      if (comments.length > 0) localStorage.setItem(storeKey, JSON.stringify(comments));
      else localStorage.removeItem(storeKey);
    } catch {
      // Storage can be blocked. The comments still work for this visit.
    }
  }, [comments, storeKey]);
  const [sending, setSending] = useState(false);
  // Comments whose line has since changed or left the diff. They show apart from the lines.
  const outdated = useMemo(() => (diff ? outdatedComments(comments, diff.files) : []), [comments, diff]);
  const current = useMemo(() => comments.filter((c) => !outdated.includes(c)), [comments, outdated]);
  // Comments can go to the executor while the change is in Review or waiting for your approval.
  const canComment = task.column === "review" || task.column === "merge_approval";

  async function sendComments() {
    setSending(true);
    setError(null);
    try {
      await api.requestChanges(task.id, commentsToNotes(comments));
      setComments([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const load = useMemo(
    () =>
      serialLoader(async () => {
        try {
          const [r, d] = await Promise.all([api.getReport(task.id), api.getDiff(task.id)]);
          setReport(r);
          setDiff(d);
          setError(null);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setLoaded(true);
        }
      }),
    [task.id],
  );

  // version bumps on every chat message, so an open tab shows new commits as they land.
  // Each load runs git diff on the server, so reload at most every 3 seconds while the agent works.
  const lastLoad = useRef(0);
  useEffect(() => {
    if (!active) return;
    const wait = lastLoad.current + 3000 - Date.now();
    const timer = window.setTimeout(
      () => {
        lastLoad.current = Date.now();
        load();
      },
      Math.max(0, wait),
    );
    return () => window.clearTimeout(timer);
  }, [active, version, load]);

  if (!loaded) return <p className="m-auto p-6 text-sm text-muted-foreground">Loading changes...</p>;
  if (!diff && !report) {
    return (
      <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        No changes yet. The executor creates a branch once the plan is approved.
      </p>
    );
  }

  return (
    // Flex columns, not grid: a grid track grows to fit a wide diff line, while a flex column stays
    // the panel's width and lets the diff box scroll sideways on its own.
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {diff && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{diff.branch}</code>
          <span className="text-muted-foreground">from</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{diff.base}</code>
          {diff.dirty && (
            <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-300">
              Uncommitted changes
            </Badge>
          )}
        </div>
      )}

      {report ? (
        <ReportView artifact={report} />
      ) : (
        <p className="text-sm text-muted-foreground">The executor hasn't reported yet. The commits below update as it works.</p>
      )}

      {diff && diff.commits.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Commits ({diff.commits.length})
          </h3>
          <ul className="grid gap-1.5 text-sm">
            {diff.commits.map((c) => (
              <li key={c.hash} className="flex items-start gap-2">
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <code className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{c.hash}</code>
                <span className="[overflow-wrap:anywhere]">{c.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {diff && diff.files.length > 0 && (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Files ({diff.files.length})
          </h3>
          <div className="flex min-w-0 flex-col gap-2">
            {diff.files.map((f) => (
              <FileDiff
                key={f.path}
                file={f}
                canComment={canComment && !sending}
                comments={current.filter((c) => c.path === f.path)}
                onAdd={(c) => setComments((all) => [...all, { ...c, id: Math.max(0, ...all.map((a) => a.id)) + 1 }])}
                onRemove={(id) => setComments((all) => all.filter((c) => c.id !== id))}
              />
            ))}
          </div>
        </section>
      )}

      {comments.length > 0 && (
        <div className="sticky bottom-0 -mx-4 -mb-4 grid gap-2 border-t bg-background px-4 py-3">
          {outdated.length > 0 && (
            <div className="grid gap-1 text-xs">
              <p className="text-muted-foreground">
                The executor changed these lines since you commented. They still go out with the code they quote.
              </p>
              <ul className="grid gap-1">
                {outdated.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 rounded-md border px-2 py-1">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <code className="font-mono">{c.path}</code>: {c.text}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove comment"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setComments((all) => all.filter((x) => x.id !== c.id))}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
          </span>
          {canComment ? (
            <Button size="sm" disabled={sending} onClick={() => void sendComments()}>
              <Send aria-hidden="true" />
              Send to the executor
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">You can send them once the task is in Review or Merge approval.</span>
          )}
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => setComments([])}>
            Discard
          </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReportView({ artifact }: { artifact: ExecutionArtifact }) {
  const { report } = artifact;
  const problemChecks = report.verification.filter((v) => v.result !== "passed");
  const passedChecks = report.verification.filter((v) => v.result === "passed");
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Execution report</h3>
        <Headline>{reportHeadline(report)}</Headline>
        <ClampedProse className="text-sm text-muted-foreground" maxHeight={96}>
          {report.summary}
        </ClampedProse>
      </div>

      <Bullets title="Deviations from the plan" items={report.deviations} />
      {problemChecks.length > 0 && <Checks title="Checks that did not pass" checks={problemChecks} />}

      {(passedChecks.length > 0 || report.followUps.length > 0) && (
        <MoreDetails
          label={[
            passedChecks.length ? `${passedChecks.length} passed ${passedChecks.length === 1 ? "check" : "checks"}` : "",
            report.followUps.length ? `${report.followUps.length} follow-up${report.followUps.length === 1 ? "" : "s"}` : "",
          ]
            .filter(Boolean)
            .join(", ")}
        >
          {passedChecks.length > 0 && <Checks title="Checks" checks={passedChecks} />}
          <Bullets title="Follow-ups" items={report.followUps} />
        </MoreDetails>
      )}
    </section>
  );
}

function Checks({ title, checks }: { title: string; checks: ExecutionArtifact["report"]["verification"] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="grid gap-2 text-sm">
        {checks.map((v, i) => (
          <li key={i} className="flex items-start gap-2">
            <CheckIcon result={v.result} />
            <div className="grid min-w-0 gap-0.5">
              <code className="font-mono text-xs [overflow-wrap:anywhere]">{v.command}</code>
              {v.notes && <span className="text-xs text-muted-foreground">{v.notes}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CheckIcon({ result }: { result: "passed" | "failed" | "not_run" }) {
  if (result === "passed") {
    return <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Passed" />;
  }
  if (result === "failed") return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />;
  return <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not run" />;
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i}>
            <Prose>{item}</Prose>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileDiff({
  file,
  canComment,
  comments,
  onAdd,
  onRemove,
}: {
  file: DiffFile;
  canComment: boolean;
  comments: LineComment[];
  onAdd: (comment: Omit<LineComment, "id">) => void;
  onRemove: (id: number) => void;
}) {
  // Only the hunk lines are shown. The "diff --git", "index" and "---/+++" header lines repeat the file name.
  const lines = useMemo(() => parseHunks(file.patch), [file.patch]);
  // The line with an open comment box, by its key.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const byLine = useMemo(() => {
    const map = new Map<string, LineComment[]>();
    for (const c of comments) map.set(commentKey(c), [...(map.get(commentKey(c)) ?? []), c]);
    return map;
  }, [comments]);

  function save(line: DiffLine) {
    if (!draft.trim() || line.kind === "hunk" || line.kind === "meta") return;
    onAdd({ path: file.path, kind: line.kind, oldNo: line.oldNo, newNo: line.newNo, code: line.text.slice(1), text: draft.trim() });
    setDraft("");
    setEditing(null);
  }

  return (
    <details className="group min-w-0 rounded-lg border">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm select-none">
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.binary ? (
          <Badge variant="outline">binary</Badge>
        ) : (
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-destructive">-{file.deletions}</span>
          </span>
        )}
      </summary>
      {!file.binary && (
        <div className="overflow-x-auto border-t">
          <pre className="min-w-fit py-1 font-mono text-xs leading-5">
            {lines.map((line, i) => {
              const key = lineKey(file.path, line);
              const here = line.kind === "hunk" || line.kind === "meta" ? [] : (byLine.get(key) ?? []);
              const commentable = canComment && line.kind !== "hunk" && line.kind !== "meta";
              return (
                <div key={i}>
                  <div
                    className={cn(
                      "group/line flex whitespace-pre",
                      line.kind === "add" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                      line.kind === "del" && "bg-red-500/10 text-red-800 dark:text-red-200",
                      line.kind === "hunk" && "bg-muted text-muted-foreground",
                    )}
                  >
                    <span className="flex w-6 shrink-0 justify-center">
                      {commentable && (
                        <button
                          type="button"
                          aria-label={`Comment on line ${line.newNo ?? line.oldNo}`}
                          className="opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
                          onClick={() => {
                            setDraft("");
                            setEditing(editing === key ? null : key);
                          }}
                        >
                          <MessageSquarePlus className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </span>
                    <span className="pr-3">{line.text || " "}</span>
                  </div>
                  {(here.length > 0 || editing === key) && (
                    <div className="sticky left-0 my-1 ml-6 grid w-[32rem] max-w-[calc(100vw-5rem)] gap-1.5 font-sans whitespace-normal">
                      {here.map((c) => (
                        <div key={c.id} className="flex items-start gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm">
                          <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text}</span>
                          <button
                            type="button"
                            aria-label="Remove comment"
                            className="mt-0.5 text-muted-foreground hover:text-foreground"
                            onClick={() => onRemove(c.id)}
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                      {editing === key && (
                        <div className="grid gap-1.5">
                          <Textarea
                            autoFocus
                            rows={2}
                            value={draft}
                            placeholder="What should change on this line?"
                            aria-label="Comment"
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(line);
                              if (e.key === "Escape") setEditing(null);
                            }}
                          />
                          <div className="flex gap-2">
                            <Button size="xs" disabled={!draft.trim()} onClick={() => save(line)}>
                              Add comment
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </pre>
          {file.truncated && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              This diff is too long to show in full. Open the branch in your editor to see the rest.
            </p>
          )}
        </div>
      )}
    </details>
  );
}
