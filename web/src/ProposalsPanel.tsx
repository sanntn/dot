import { kindDef, type ProposalDecision, type ProposalsArtifact, type Task } from "@dot/shared";
import { Check, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "./api.ts";
import { Headline } from "./detail.tsx";
import { ReviewBar } from "./ReviewBar.tsx";

// A triage task's output: tasks the agent proposes. Nothing exists until you accept an item.
// With the list focused, j and k move, a accepts and r rejects the current item.
export function ProposalsPanel({ task, artifact, active }: { task: Task; artifact: ProposalsArtifact | null; active: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The answer to your last click, shown until the board's own refresh catches up.
  const [local, setLocal] = useState<ProposalsArtifact | null>(null);
  const [current, setCurrent] = useState(0);
  const reviewing = task.column === "triage_review";

  useEffect(() => setLocal(null), [artifact]);
  const view = local && (!artifact || local.version >= artifact.version) ? local : artifact;

  if (!view) {
    return (
      <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        {task.column === "inbox" ? "No proposals yet. Start the task and the agent will sort the input." : "The agent is still reading the input."}
      </p>
    );
  }

  const { proposals, decisions } = view;
  const decidable = proposals.items.flatMap((item, i) => (item.action === "create_task" ? [i] : []));
  const open = decidable.filter((i) => !decisions[i]);

  async function decide(accept: number[], reject: number[]) {
    if (!view || busy || accept.length + reject.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setLocal(await api.decideProposals(task.id, { version: view.version, accept, reject }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!reviewing || e.metaKey || e.ctrlKey || e.altKey || open.length === 0) return;
    const at = Math.min(current, open.length - 1);
    if (e.key === "j" || e.key === "ArrowDown") setCurrent(Math.min(at + 1, open.length - 1));
    else if (e.key === "k" || e.key === "ArrowUp") setCurrent(Math.max(at - 1, 0));
    else if (e.key === "a") void decide([open[at]!], []);
    else if (e.key === "r") void decide([], [open[at]!]);
    else return;
    e.preventDefault();
  }

  const currentItem = open[Math.min(current, open.length - 1)];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" tabIndex={reviewing && active ? 0 : -1} onKeyDown={onKeyDown} aria-label="Proposed tasks">
        <p className="mb-4 text-xs text-muted-foreground">
          Version {view.version}, {new Date(view.createdAt).toLocaleString()}
        </p>
        <div className="grid gap-2">
          <Headline>{proposals.headline}</Headline>
          <p className="text-sm text-muted-foreground">{proposals.summary}</p>
        </div>

        {reviewing && open.length > 1 && (
          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">j and k move, a accepts, r rejects.</p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(open, [])}>
              Accept all {open.length}
            </Button>
          </div>
        )}

        <ol className="mt-4 grid gap-3">
          {proposals.items.map((item, i) => {
            const decision: ProposalDecision | undefined = decisions[i];
            const isTask = item.action === "create_task";
            const focused = reviewing && isTask && !decision && i === currentItem;
            return (
              <li
                key={i}
                className={cn(
                  "grid gap-2 rounded-lg border p-3 text-sm",
                  !isTask && "border-dashed text-muted-foreground",
                  decision?.status === "rejected" && "opacity-60",
                  focused && "ring-2 ring-ring",
                )}
                aria-current={focused || undefined}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground [overflow-wrap:anywhere]">{item.title}</span>
                  {isTask ? (
                    <Badge variant="secondary">{kindDef(item.taskKind ?? "code").label}</Badge>
                  ) : (
                    <Badge variant="outline">Dropped</Badge>
                  )}
                  {decision?.status === "accepted" && <Badge>Created in the Inbox</Badge>}
                  {decision?.status === "rejected" && <Badge variant="outline">Rejected</Badge>}
                </div>
                <p className="[overflow-wrap:anywhere]">{item.reason}</p>
                {/* Open by default: an accepted task starts from this text, and the agent wrote it after reading untrusted input. */}
                {item.description && (
                  <div className="grid gap-1 rounded-md bg-muted/50 p-2 text-muted-foreground">
                    <span className="text-xs font-medium">Task description</span>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.description}</p>
                  </div>
                )}
                {reviewing && isTask && !decision && (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide([], [i])}>
                      <X aria-hidden="true" />
                      Reject
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void decide([i], [])}>
                      <Check aria-hidden="true" />
                      Accept
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {reviewing && (
        <div className="grid border-t">
          {open.length > 0 && (
            <p className="px-3 pt-3 text-xs text-muted-foreground">
              {open.length} undecided {open.length === 1 ? "proposal is" : "proposals are"} dropped when you finish.
            </p>
          )}
          <ReviewBar
            agent="triage agent"
            approveLabel="Finish triage"
            busy={busy}
            error={error}
            onApprove={() => void run(() => api.finishTriage(task.id))}
            onSendBack={(notes) => run(() => api.sendBackProposals(task.id, notes))}
          />
        </div>
      )}
      {!reviewing && error && <p className="px-4 pb-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
