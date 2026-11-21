import type { Project, SearchHit, Task } from "@dot/shared";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "./api.ts";
import { LANE_LABELS, laneOf } from "./lanes.ts";
import { VIEWS, VIEW_LABELS, type View } from "./views.ts";

export type CommandItem = {
  id: string;
  group: "Actions" | "Tasks" | "Projects" | "Matches";
  label: string;
  hint?: string;
  // Text around a match in the task, with  before and  after each matched word.
  snippet?: string;
  run: () => void;
};

// Builds the list from what the board already holds. Nothing here calls the server.
export function buildCommands(input: {
  tasks: Task[];
  projects: Project[];
  projectId: number | null;
  newTask: (() => void) | null;
  importIssues: (() => void) | null;
  shortcuts: () => void;
  allProjects: () => void;
  goTo: (view: View) => void;
  openTask: (task: Task) => void;
  selectProject: (id: number) => void;
}): CommandItem[] {
  const items: CommandItem[] = [];
  if (input.newTask) items.push({ id: "new-task", group: "Actions", label: "New task", run: input.newTask });
  if (input.importIssues) items.push({ id: "import-issues", group: "Actions", label: "Import issues and cards", run: input.importIssues });
  if (input.projects.length > 1) items.push({ id: "all-projects", group: "Actions", label: "All projects", run: input.allProjects });
  for (const view of VIEWS) items.push({ id: `view-${view}`, group: "Actions", label: `Go to ${VIEW_LABELS[view]}`, run: () => input.goTo(view) });
  items.push({ id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", run: input.shortcuts });
  for (const task of input.tasks) {
    items.push({
      id: `task-${task.id}`,
      group: "Tasks",
      label: `#${task.number} ${task.title}`,
      hint: LANE_LABELS[laneOf(task)],
      run: () => input.openTask(task),
    });
  }
  for (const project of input.projects) {
    if (project.id === input.projectId) continue;
    items.push({
      id: `project-${project.id}`,
      group: "Projects",
      label: `Switch to ${project.name}`,
      run: () => input.selectProject(project.id),
    });
  }
  return items;
}

const HIT_KINDS: Record<SearchHit["kind"], string> = {
  task: "Brief",
  message: "Chat",
  plan: "Plan",
  report: "Report",
  document: "Report",
  review: "Review",
};

// The matched words of a snippet go in <mark>. The server wraps them in two control characters.
function Highlighted({ text }: { text: string }) {
  return (
    <>
      {text.split("").map((part, i) => {
        const [hit, rest] = i === 0 ? [null, part] : part.split("");
        return (
          <Fragment key={i}>
            {hit !== null && <mark className="rounded-sm bg-primary/20 px-0.5 text-foreground">{hit}</mark>}
            {rest}
          </Fragment>
        );
      })}
    </>
  );
}

// Searches the text inside tasks on the server, once the query has two characters and typing pauses.
function useTextMatches(query: string): SearchHit[] {
  const [found, setFound] = useState<{ query: string; hits: SearchHit[] }>({ query: "", hits: [] });
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .search(q, controller.signal)
        .then((hits) => setFound({ query: q, hits }))
        .catch(() => {
          // A cancelled or failed search leaves the label matches in place.
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  // Matches that belong to an earlier query are not shown while the new one is still loading.
  return found.query === query.trim() ? found.hits : [];
}

export function CommandMenu({
  items,
  onClose,
  openHit,
}: {
  items: CommandItem[];
  onClose: () => void;
  openHit: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const textHits = useTextMatches(query);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    const byLabel = items.filter((i) => i.label.toLowerCase().includes(q));
    // A task that matched by its title is already listed, so the text matches add only the others.
    const listed = new Set(byLabel.map((i) => i.id));
    const byText: CommandItem[] = textHits
      .filter((hit) => !listed.has(`task-${hit.taskId}`))
      .map((hit) => ({
        id: `match-${hit.taskId}`,
        group: "Matches",
        label: `#${hit.number} ${hit.title}`,
        hint: `${HIT_KINDS[hit.kind]}, ${hit.projectName}`,
        snippet: hit.snippet,
        run: () => openHit(hit),
      }));
    return [...byLabel, ...byText];
  }, [items, query, textHits, openHit]);

  const index = Math.min(active, Math.max(shown.length - 1, 0));

  function choose(item: CommandItem | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const next = (index + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      setActive(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[index]);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-[20%] translate-y-0 gap-3 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>Search and commands</DialogTitle>
          <DialogDescription>Type to filter. Arrow keys move, Enter runs. Matches inside tasks appear after a pause.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={shown[index] ? `${baseId}-${shown[index].id}` : undefined}
          aria-label="Search tasks, projects and actions"
          placeholder="Search tasks, projects and actions"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul id={`${baseId}-list`} ref={listRef} role="listbox" aria-label="Results" className="max-h-72 overflow-y-auto">
          {shown.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">No matches</li>}
          {shown.map((item, i) => (
            <li
              key={item.id}
              id={`${baseId}-${item.id}`}
              role="option"
              aria-selected={i === index}
              data-index={i}
              className={cn(
                "flex cursor-default items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm",
                i === index && "bg-accent text-accent-foreground",
              )}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className="min-w-0">
                <span className="block truncate">{item.label}</span>
                {item.snippet && (
                  <span className="block truncate text-xs text-muted-foreground">
                    <Highlighted text={item.snippet} />
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{item.hint ?? item.group}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
