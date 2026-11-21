import { kindDef, OUTPUTS_LIMIT, TASK_KINDS, type Project, type TaskKind } from "@dot/shared";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { api } from "./api.ts";
import { ScopeSelect, scopeProjectId, selectClass, useScope } from "./ScopeSelect.tsx";
import { useLive } from "./useLive.ts";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Every finished task with what it produced, across kinds. Pick a row to open the task.
export function OutputsView(props: {
  projects: Project[];
  currentId: number | null;
  onOpen: (projectId: number, taskId: number) => void;
}) {
  const [scope, setScope] = useScope(props.currentId);
  const [kind, setKind] = useState<TaskKind | "">("");
  const [query, setQuery] = useState("");
  const { data: outputs, error } = useLive(
    () => api.outputs({ projectId: scopeProjectId(scope), kind: kind || undefined, q: query }),
    [scope, kind, query],
    query ? 200 : 0,
  );

  return (
    <main className="mx-auto grid w-full max-w-4xl content-start gap-4 overflow-y-auto px-4 py-4">
      <div>
        <h2 className="text-lg font-semibold">Outputs</h2>
        <p className="text-sm text-muted-foreground">What finished tasks produced. Pick one to open it.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          aria-label="Search outputs"
          placeholder="Search finished tasks"
          className="min-w-48 flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ScopeSelect projects={props.projects} value={scope} onChange={setScope} />
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
                  <button type="button" className="text-left font-medium hover:underline focus-visible:underline" onClick={() => props.onOpen(o.projectId, o.taskId)}>
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
    </main>
  );
}
