import { COLUMN_LABELS, type Project } from "@dot/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "./api.ts";
import { ReportPanel } from "./ReportPanel.tsx";
import { ScopeSelect, scopeProjectId, useScope } from "./ScopeSelect.tsx";
import { useLive } from "./useLive.ts";

// Every report an agent has written, with the document beside the list. Approving or sending back works here
// as it does in the task.
export function DocumentsView(props: {
  projects: Project[];
  currentId: number | null;
  onOpen: (projectId: number, taskId: number) => void;
}) {
  const [scope, setScope] = useScope(props.currentId);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const { data: entries, error } = useLive(() => api.documents({ projectId: scopeProjectId(scope), q: query }), [scope, query], query ? 200 : 0);

  // Show the picked report, or the newest when none is picked or the picked one is filtered out.
  const selected = entries?.find((e) => e.task.id === picked) ?? entries?.[0] ?? null;
  // The answer says which task it is for, so one report's text never shows under another report's title.
  const { data: loaded } = useLive(
    () => (selected ? api.getReportDoc(selected.task.id).then((artifact) => ({ taskId: selected.task.id, artifact })) : Promise.resolve(null)),
    // A newer version loads when the list reports one.
    [selected?.task.id, selected?.version],
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col md:flex-row">
      <section aria-label="Reports" className="flex max-h-72 shrink-0 flex-col gap-3 border-b p-3 md:max-h-none md:w-80 md:border-r md:border-b-0">
        <div className="flex gap-2">
          <Input type="search" aria-label="Search reports" placeholder="Search reports" className="min-w-0 flex-1" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ScopeSelect projects={props.projects} value={scope} onChange={setScope} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!entries && !error && <p className="text-sm text-muted-foreground">Loading...</p>}
        {entries && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">{query ? "Nothing matches." : "No reports yet. A report task writes one when its research is done."}</p>
        )}
        <ul className="grid min-h-0 gap-1 overflow-y-auto">
          {entries?.map((e) => (
            <li key={e.task.id}>
              <button
                type="button"
                aria-current={selected?.task.id === e.task.id || undefined}
                onClick={() => setPicked(e.task.id)}
                className={cn("grid w-full gap-0.5 rounded-lg border border-transparent p-2 text-left text-sm hover:bg-muted", selected?.task.id === e.task.id && "border-border bg-muted")}
              >
                <span className="font-medium [overflow-wrap:anywhere]">{e.headline}</span>
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  #{e.task.number} {e.task.title}
                  {scope === "all" && props.projects.length > 1 ? ` in ${e.projectName}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {e.task.column === "report_review" ? "Waiting for you" : COLUMN_LABELS[e.task.column]}, {new Date(e.updatedAt).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Report" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
              <span className="truncate text-sm font-medium">
                #{selected.task.number} {selected.task.title}
              </span>
              <Button variant="outline" size="sm" onClick={() => props.onOpen(selected.task.projectId, selected.task.id)}>
                Open task
              </Button>
            </div>
            {loaded?.taskId === selected.task.id ? (
              <ReportPanel key={selected.task.id} task={selected.task} artifact={loaded.artifact} />
            ) : (
              <p className="m-auto text-sm text-muted-foreground">Loading...</p>
            )}
          </>
        ) : (
          <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">Pick a report to read it here.</p>
        )}
      </section>
    </main>
  );
}
