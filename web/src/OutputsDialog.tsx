import { kindDef, OUTPUTS_LIMIT, TASK_KINDS, type Output, type Project, type TaskKind } from "@dot/shared";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "./api.ts";
import { subscribe } from "./events.ts";

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Every finished task with what it produced, across kinds. Pick a row to open the task.
export function OutputsDialog(props: {
  projects: Project[];
  currentId: number | null;
  onOpen: (output: Output) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<string>(props.currentId === null ? "all" : String(props.currentId));
  const [kind, setKind] = useState<TaskKind | "">("");
  const [query, setQuery] = useState("");
  const [outputs, setOutputs] = useState<Output[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Only the newest request may set the list, so a slow earlier answer cannot overwrite it.
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      return api.outputs({ projectId: scope === "all" ? undefined : Number(scope), kind: kind || undefined, q: query }).then(
        (found) => alive && mine === latest && (setOutputs(found), setError(null)),
        (err) => alive && mine === latest && setError(errorMessage(err)),
      );
    };
    // Wait for a pause in typing, so each key does not search.
    const timer = window.setTimeout(() => void load(), query ? 200 : 0);
    // A task reaching Done adds a row. Agents publish often, so one pause covers a burst of events.
    let eventTimer: number | undefined;
    const stop = subscribe({
      onEvent: (e) => {
        if (e.type !== "tasks.changed") return;
        window.clearTimeout(eventTimer);
        eventTimer = window.setTimeout(() => void load(), 1000);
      },
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearTimeout(eventTimer);
      stop();
    };
  }, [scope, kind, query]);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Outputs</DialogTitle>
          <DialogDescription>What finished tasks produced. Pick one to open it.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Input
            type="search"
            aria-label="Search outputs"
            placeholder="Search finished tasks"
            className="min-w-48 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label="Project" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All projects</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select aria-label="Kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as TaskKind | "")}>
            <option value="">All kinds</option>
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindDef(k).label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!outputs && !error && <p className="text-sm text-muted-foreground">Loading...</p>}
        {outputs && outputs.length === 0 && (
          <p className="text-sm text-muted-foreground">{query || kind ? "Nothing matches." : "No finished tasks yet."}</p>
        )}
        {outputs && outputs.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Task</th>
                <th className="py-1 pr-3 font-medium">Kind</th>
                <th className="py-1 font-medium">Finished</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((o) => (
                <tr key={o.taskId} className="border-t align-top">
                  <td className="py-2 pr-3">
                    <button type="button" className="text-left font-medium hover:underline focus-visible:underline" onClick={() => props.onOpen(o)}>
                      #{o.number} {o.title}
                    </button>
                    {scope === "all" && props.projects.length > 1 && <span className="text-xs text-muted-foreground"> in {o.projectName}</span>}
                    {o.headline && <div className="text-muted-foreground">{o.headline}</div>}
                    {o.url && (
                      <a className="text-xs underline" href={o.url} target="_blank" rel="noreferrer">
                        Pull request
                      </a>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">{kindDef(o.kind).label}</td>
                  <td className="whitespace-nowrap py-2">{formatDate(o.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {outputs && outputs.length >= OUTPUTS_LIMIT && (
          <p className="text-xs text-muted-foreground">Showing the latest {OUTPUTS_LIMIT}. Search or filter to narrow.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
