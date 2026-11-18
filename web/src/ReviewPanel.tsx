import { reviewHeadline, type ReviewArtifact, type ReviewIssue, type Task } from "@dot/shared";
import { Check, CircleCheck, CircleHelp, CircleX, CornerUpLeft, Plus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "./api.ts";
import { CheckIcon } from "./ChangesPanel.tsx";
import { ClampedProse, Headline, MoreDetails } from "./detail.tsx";
import { Prose } from "./Prose.tsx";
import { RuleSuggestions } from "./RulesSection.tsx";

export function ReviewPanel({ task, artifact, working }: { task: Task; artifact: ReviewArtifact | null; working: boolean }) {
  const [requesting, setRequesting] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notesId = useId();

  // You can step in while the task waits in Review, Merge approval or Merge, but not while an agent
  // or the merge step is working on it.
  const canAct = (task.column === "review" || task.column === "merge_approval" || task.column === "merge") && !working;
  const canApprove = task.column === "review" && !working;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const blocking = artifact?.review.issues.filter((i) => i.severity === "blocking") ?? [];
  const optional = artifact?.review.issues.filter((i) => i.severity === "non_blocking") ?? [];
  const failedChecks = artifact?.review.checks.filter((c) => c.result === "failed") ?? [];
  const allMet = artifact !== null && artifact.review.criteria.length > 0 && artifact.review.criteria.every((c) => c.status === "met");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
        {!artifact ? (
          <p className="m-auto max-w-sm text-center text-sm text-muted-foreground">
            {task.column === "review" && working
              ? "The reviewer is checking the work."
              : "No review yet. The reviewer starts when the executor reports its work."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {artifact.review.verdict === "approve" ? (
                <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  <Check aria-hidden="true" />
                  Approved
                </Badge>
              ) : (
                <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">Changes requested</Badge>
              )}
              <span className="text-xs text-muted-foreground">
                Round {artifact.version}, {new Date(artifact.createdAt).toLocaleString()}
              </span>
            </div>

            <Headline>{reviewHeadline(artifact.review)}</Headline>
            <ClampedProse className="text-sm text-muted-foreground" maxHeight={96}>
              {artifact.review.summary}
            </ClampedProse>

            {allMet ? (
              <p className="flex items-center gap-2 text-sm">
                <CriterionIcon status="met" />
                {artifact.review.criteria.length === 1
                  ? "The acceptance criterion is met."
                  : `All ${artifact.review.criteria.length} acceptance criteria are met.`}
              </p>
            ) : (
              <Section title="Acceptance criteria">
                <CriteriaList criteria={artifact.review.criteria} />
              </Section>
            )}

            {blocking.length > 0 && (
              <Section title={`Blocking issues (${blocking.length})`}>
                {blocking.map((issue, i) => (
                  <IssueCard key={i} issue={issue} task={task} />
                ))}
              </Section>
            )}

            {failedChecks.length > 0 && (
              <Section title={`Failed checks (${failedChecks.length})`}>
                <ChecksList checks={failedChecks} />
              </Section>
            )}

            {(allMet || optional.length > 0 || artifact.review.checks.length > 0) && (
              <MoreDetails label={detailLabel(allMet, optional.length, artifact.review.checks.length)} className="gap-6">
                {allMet && (
                  <Section title="Acceptance criteria">
                    <CriteriaList criteria={artifact.review.criteria} />
                  </Section>
                )}
                {optional.length > 0 && (
                  <Section title={`Non-blocking (${optional.length})`}>
                    {optional.map((issue, i) => (
                      <IssueCard key={i} issue={issue} task={task} canCreateTask />
                    ))}
                  </Section>
                )}
                {artifact.review.checks.length > 0 && (
                  <Section title="Checks">
                    <ChecksList checks={artifact.review.checks} />
                  </Section>
                )}
              </MoreDetails>
            )}

            <RuleSuggestions task={task} />
          </>
        )}
      </div>

      {canAct && (
        <div className="flex flex-col gap-3 border-t bg-background p-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {requesting ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={async (e: FormEvent) => {
                e.preventDefault();
                if (await run(() => api.requestChanges(task.id, notes))) {
                  setNotes("");
                  setRequesting(false);
                }
              }}
            >
              <Label htmlFor={notesId}>What should the executor change?</Label>
              <p id={`${notesId}-hint`} className="text-xs text-muted-foreground">
                This sends the task back to the executor, and the reviewer checks it again. To ask a question
                without changing the code, message the executor in the Chat tab.
              </p>
              <Textarea
                id={notesId}
                aria-describedby={`${notesId}-hint`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                autoFocus
                required
                className="max-h-48 min-h-20"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setRequesting(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !notes.trim()}>
                  <CornerUpLeft aria-hidden="true" />
                  Send to executor
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRequesting(true)}>
                <CornerUpLeft aria-hidden="true" />
                Request changes
              </Button>
              {canApprove && (
                <Button type="button" disabled={busy} onClick={() => void run(() => api.approveReview(task.id))}>
                  <Check aria-hidden="true" />
                  {artifact?.review.verdict === "changes_requested" ? "Approve anyway" : "Approve"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function detailLabel(allMet: boolean, optional: number, checks: number): string {
  const parts: string[] = [];
  if (allMet) parts.push("criteria and evidence");
  if (optional) parts.push(`${optional} non-blocking`);
  if (checks) parts.push(`${checks} ${checks === 1 ? "check" : "checks"}`);
  return parts.join(", ");
}

function CriteriaList({ criteria }: { criteria: ReviewArtifact["review"]["criteria"] }) {
  return (
    <ul className="flex flex-col gap-3 text-sm">
      {criteria.map((c, i) => (
        <li key={i} className="flex items-start gap-2">
          <CriterionIcon status={c.status} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Prose>{c.criterion}</Prose>
            <ClampedProse className="text-xs text-muted-foreground" maxHeight={60}>
              {c.evidence}
            </ClampedProse>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ChecksList({ checks }: { checks: ReviewArtifact["review"]["checks"] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {checks.map((v, i) => (
        <li key={i} className="flex items-start gap-2">
          <CheckIcon result={v.result} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <code className="font-mono text-xs [overflow-wrap:anywhere]">{v.command}</code>
            {v.notes && <span className="text-xs text-muted-foreground">{v.notes}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function CriterionIcon({ status }: { status: "met" | "not_met" | "unclear" }) {
  if (status === "met") {
    return <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Met" />;
  }
  if (status === "not_met") return <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Not met" />;
  return <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Unclear" />;
}

function IssueCard({ issue, task, canCreateTask }: { issue: ReviewIssue; task: Task; canCreateTask?: boolean }) {
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : null;

  async function createTask() {
    setError(null);
    try {
      const t = await api.createTask({
        projectId: task.projectId,
        title: issue.title,
        description: [
          `From the review of task #${task.number} (${task.title}).`,
          "",
          issue.details,
          location ? `\nLocation: ${location} on branch ${task.branch ?? "(unknown)"}` : "",
        ].join("\n"),
      });
      setCreated(t.number);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span className="flex-1 text-sm font-medium">{issue.title}</span>
        {canCreateTask &&
          (created ? (
            <span className="text-xs text-muted-foreground" role="status">
              Task #{created} created
            </span>
          ) : (
            <Button type="button" variant="ghost" size="xs" onClick={() => void createTask()}>
              <Plus aria-hidden="true" />
              Create task
            </Button>
          ))}
      </div>
      {location && <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{location}</code>}
      <Prose className="text-sm text-muted-foreground">{issue.details}</Prose>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
