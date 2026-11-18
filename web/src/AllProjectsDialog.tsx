import type { Project, ProjectOverview } from "@dot/shared";
import { LANES } from "@dot/shared";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "./api.ts";
import { subscribe } from "./events.ts";
import { LANE_LABELS } from "./lanes.ts";

// Every project with its lane counts. The ones with tasks waiting on you come first.
export function AllProjectsDialog(props: {
  projects: Project[];
  currentId: number | null;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const [overview, setOverview] = useState<ProjectOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.overview().then(
        (next) => alive && (setOverview(next), setError(null)),
        (err) => alive && setError(errorMessage(err)),
      );
    void load();
    const stop = subscribe({
      onEvent: (event) => {
        if (event.type === "tasks.changed" || event.type === "projects.changed") void load();
      },
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const rows = props.projects
    .map((project) => ({ project, info: overview?.find((o) => o.projectId === project.id) ?? null }))
    .sort((a, b) => (b.info?.lanes.needs_you ?? 0) - (a.info?.lanes.needs_you ?? 0) || a.project.name.localeCompare(b.project.name));

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>All projects</DialogTitle>
          <DialogDescription>Pick a project to open its board.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!overview && !error && <p className="text-sm text-muted-foreground">Loading</p>}
        <ul className="grid max-h-96 gap-2 overflow-y-auto">
          {rows.map(({ project, info }) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => {
                  props.onClose();
                  props.onPick(project.id);
                }}
                aria-current={project.id === props.currentId || undefined}
                className={cn(
                  "grid w-full gap-2 rounded-xl border p-3 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                  project.id === props.currentId && "border-primary/40",
                )}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{project.name}</span>
                  {info && info.running > 0 && (
                    <span className="text-xs text-muted-foreground">{info.running} running</span>
                  )}
                </span>
                {info && (
                  <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {LANES.map((lane) => (
                      <span key={lane} className={cn(lane === "needs_you" && info.lanes[lane] > 0 && "font-medium text-amber-700 dark:text-amber-300")}>
                        <span className="tabular-nums">{info.lanes[lane]}</span> {LANE_LABELS[lane].toLowerCase()}
                      </span>
                    ))}
                  </span>
                )}
                {info?.waiting.map((w) => (
                  <span key={w.id} className="truncate text-xs">
                    <span className="tabular-nums text-muted-foreground">#{w.number}</span> {w.title}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
