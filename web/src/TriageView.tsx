import { kindDef, type Project, type TriageEntry } from "@dot/shared";
import { Check, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "./api.ts";
import { ScopeSelect, scopeProjectId, useScope } from "./ScopeSelect.tsx";
import { useLive } from "./useLive.ts";

type Open = { entry: TriageEntry; index: number };

// Every proposed task still waiting for a decision, from all triage tasks in one list. With the list focused,
// j and k move, a accepts and r rejects. Finishing a triage drops what you left undecided, as in the task.
export function TriageView(props: { projects: Project[]; currentId: number | null; onOpen: (projectId: number, taskId: number) => void }) {
  const [scope, setScope] = useScope(props.currentId);
  const { data: entries, error: loadError, reload } = useLive(() => api.triageQueue(scopeProjectId(scope)), [scope]);
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open: Open[] = (entries ?? []).flatMap((entry) =>
    entry.artifact.proposals.items.flatMap((item, index) =>
      item.action === "create_task" && !entry.artifact.decisions[index] ? [{ entry, index }] : [],
    ),
  );
  const at = Math.min(current, Math.max(open.length - 1, 0));

  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (err) {
      setError(errorMessage(err));
      reload();
    } finally {
      setBusy(false);
    }
  }

  const decide = (entry: TriageEntry, accept: number[], reject: number[]) =>
    act(() => api.decideProposals(entry.task.id, { version: entry.artifact.version, accept, reject }));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey || open.length === 0) return;
    const item = open[at]!;
    if (e.key === "j" || e.key === "ArrowDown") setCurrent(Math.min(at + 1, open.length - 1));
    else if (e.key === "k" || e.key === "ArrowUp") setCurrent(Math.max(at - 1, 0));
    else if (e.key === "a") void decide(item.entry, [item.index], []);
    else if (e.key === "r") void decide(item.entry, [], [item.index]);
    else return;
    e.preventDefault();
  }

  const showError = error ?? loadError;

  return (
    <main className="mx-auto grid w-full max-w-3xl content-start gap-4 overflow-y-auto px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Triage</h2>
          <p className="text-sm text-muted-foreground">
            Tasks the triage agents propose. Nothing exists until you accept it. j and k move, a accepts, r rejects.
          </p>
        </div>
        <ScopeSelect projects={props.projects} value={scope} onChange={setScope} />
      </div>

      {showError && (
        <p role="alert" className="text-sm text-destructive">
          {showError}
        </p>
      )}
      {!entries && !showError && <p className="text-sm text-muted-foreground">Loading...</p>}
      {entries && entries.length === 0 && <p className="text-sm text-muted-foreground">Nothing to triage. A triage task shows up here when its agent submits proposals.</p>}

      <div className="grid gap-6 outline-none" tabIndex={open.length > 0 ? 0 : -1} onKeyDown={onKeyDown} aria-label="Proposed tasks">
        {entries?.map((entry) => {
          const mine = open.filter((o) => o.entry.task.id === entry.task.id);
          return (
            <section key={entry.task.id} className="grid gap-3" aria-label={entry.task.title}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <button type="button" className="text-left font-medium hover:underline focus-visible:underline [overflow-wrap:anywhere]" onClick={() => props.onOpen(entry.task.projectId, entry.task.id)}>
                    #{entry.task.number} {entry.task.title}
                  </button>
                  {scope === "all" && props.projects.length > 1 && <span className="text-xs text-muted-foreground"> in {entry.projectName}</span>}
                  <p className="text-sm text-muted-foreground">{entry.artifact.proposals.headline}</p>
                </div>
                <div className="flex gap-2">
                  {mine.length > 1 && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(entry, mine.map((m) => m.index), [])}>
                      Accept all {mine.length}
                    </Button>
                  )}
                  <Button size="sm" variant={mine.length === 0 ? "default" : "outline"} disabled={busy} onClick={() => void act(() => api.finishTriage(entry.task.id))}>
                    Finish triage
                  </Button>
                </div>
              </div>

              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground">Every proposal is decided. Finish the triage to close the task.</p>
              ) : (
                <>
                  <ol className="grid gap-2">
                    {mine.map((m) => {
                      const item = m.entry.artifact.proposals.items[m.index]!;
                      const focused = open[at]?.entry.task.id === m.entry.task.id && open[at]?.index === m.index;
                      return (
                        <li key={m.index} aria-current={focused || undefined} className={cn("grid gap-2 rounded-lg border p-3 text-sm", focused && "ring-2 ring-ring")}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium [overflow-wrap:anywhere]">{item.title}</span>
                            <Badge variant="secondary">{kindDef(item.taskKind ?? "code").label}</Badge>
                          </div>
                          <p className="[overflow-wrap:anywhere]">{item.reason}</p>
                          {item.description && (
                            <div className="grid gap-1 rounded-md bg-muted/50 p-2 text-muted-foreground">
                              <span className="text-xs font-medium">Task description</span>
                              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.description}</p>
                            </div>
                          )}
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(m.entry, [], [m.index])}>
                              <X aria-hidden="true" />
                              Reject
                            </Button>
                            <Button size="sm" disabled={busy} onClick={() => void decide(m.entry, [m.index], [])}>
                              <Check aria-hidden="true" />
                              Accept
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    {mine.length} undecided {mine.length === 1 ? "proposal is" : "proposals are"} dropped when you finish.
                  </p>
                </>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
