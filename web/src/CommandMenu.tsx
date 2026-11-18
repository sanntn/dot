import type { Project, Task } from "@dot/shared";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LANE_LABELS, laneOf } from "./lanes.ts";

export type CommandItem = {
  id: string;
  group: "Actions" | "Tasks" | "Projects";
  label: string;
  hint?: string;
  run: () => void;
};

// Builds the list from what the board already holds. Nothing here calls the server.
export function buildCommands(input: {
  tasks: Task[];
  projects: Project[];
  projectId: number | null;
  newTask: (() => void) | null;
  shortcuts: () => void;
  openTask: (task: Task) => void;
  selectProject: (id: number) => void;
}): CommandItem[] {
  const items: CommandItem[] = [];
  if (input.newTask) items.push({ id: "new-task", group: "Actions", label: "New task", run: input.newTask });
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

export function CommandMenu({ items, onClose }: { items: CommandItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? items : items.filter((i) => i.label.toLowerCase().includes(q));
  }, [items, query]);

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
          <DialogDescription>Type to filter. Arrow keys move, Enter runs.</DialogDescription>
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
              <span className="min-w-0 truncate">{item.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{item.hint ?? item.group}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
