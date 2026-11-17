import type { DiffFile, ExecutionArtifact, Task, TaskDiff } from "@dot/shared";
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, GitBranch, GitCommitHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "./api.ts";
import { serialLoader } from "./events.ts";
import { Prose } from "./Prose.tsx";

// The executor's report, the branch's commits and its diff against the base branch.
// Loads when first shown and reloads when the task changes while visible.
export function ChangesPanel({ task, active, version }: { task: Task; active: boolean; version: number }) {
  const [report, setReport] = useState<ExecutionArtifact | null>(null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
              <FileDiff key={f.path} file={f} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ReportView({ artifact }: { artifact: ExecutionArtifact }) {
  const { report } = artifact;
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Execution report</h3>
        <Prose className="text-sm">{report.summary}</Prose>
      </div>

      {report.verification.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">Checks</h4>
          <ul className="grid gap-2 text-sm">
            {report.verification.map((v, i) => (
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
      )}

      <Bullets title="Deviations from the plan" items={report.deviations} />
      <Bullets title="Follow-ups" items={report.followUps} />
    </section>
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

function FileDiff({ file }: { file: DiffFile }) {
  // Only the hunk lines are shown. The "diff --git", "index" and "---/+++" header lines repeat the file name.
  const lines = useMemo(() => {
    const all = file.patch.split("\n");
    const start = all.findIndex((l) => l.startsWith("@@"));
    return start === -1 ? [] : all.slice(start);
  }, [file.patch]);

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
            {lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "px-3 whitespace-pre",
                  line.startsWith("+") && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                  line.startsWith("-") && "bg-red-500/10 text-red-800 dark:text-red-200",
                  line.startsWith("@@") && "bg-muted text-muted-foreground",
                )}
              >
                {line || " "}
              </div>
            ))}
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
