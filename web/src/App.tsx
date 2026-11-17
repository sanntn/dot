import type { Project, Task, TaskMove } from "@dot/shared";
import { FolderGit2, Plus, Settings, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errorMessage } from "./api.ts";
import { Board } from "./Board.tsx";
import { subscribe } from "./events.ts";
import { applyMove } from "./move.ts";
import { ProjectDialog } from "./ProjectDialog.tsx";
import { TaskDialog } from "./TaskDialog.tsx";
import { TaskSheet } from "./TaskSheet.tsx";

type OpenDialog =
  | { kind: "new-task" }
  | { kind: "task"; taskId: number }
  | { kind: "new-project" }
  | { kind: "project"; project: Project };

const PROJECT_KEY = "dot.projectId";

function readStoredProject(): number | null {
  try {
    const value = Number(localStorage.getItem(PROJECT_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeProject(id: number) {
  try {
    localStorage.setItem(PROJECT_KEY, String(id));
  } catch {
    // Storage can be blocked. The board still works, it just forgets the selection.
  }
}

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(readStoredProject);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announceTimer = useRef<number | undefined>(undefined);

  const project = projects?.find((p) => p.id === selectedId) ?? projects?.[0] ?? null;
  const projectId = project?.id ?? null;

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  // Ignore responses for a project the user has already switched away from.
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const loadTasks = useCallback(async () => {
    if (projectId === null) {
      setTasks([]);
      return;
    }
    try {
      const list = await api.listTasks(projectId);
      if (currentProject.current === projectId) setTasks(list);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(
    () =>
      subscribe({
        onOpen: () => {
          void loadProjects();
          void loadTasks();
        },
        onEvent: (event) => {
          if (event.type === "projects.changed") void loadProjects();
          else if (event.type === "tasks.changed" && event.projectId === projectId) void loadTasks();
        },
      }),
    [loadProjects, loadTasks, projectId],
  );

  // Clear first, then set after a beat, so screen readers announce repeated messages.
  const announce = useCallback((message: string) => {
    setAnnouncement("");
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => setAnnouncement(message), 150);
  }, []);

  const moveTask = useCallback(
    async (task: Task, move: TaskMove) => {
      setTasks((prev) => applyMove(prev, task.id, move));
      try {
        await api.moveTask(task.id, move);
      } catch (err) {
        setError(errorMessage(err));
        void loadTasks();
      }
    },
    [loadTasks],
  );

  function selectProject(id: number) {
    setSelectedId(id);
    storeProject(id);
  }

  const closeDialog = () => setDialog(null);

  // The panel always shows the live task from the board, so agent progress updates in place.
  const openTask = dialog?.kind === "task" ? (tasks.find((t) => t.id === dialog.taskId) ?? null) : null;

  // The dialog returns focus to the card that opened it. If the card then moves column, React remounts it
  // and focus falls to the page body. Put focus back on the card once the board has re-rendered.
  const refocusTaskId = useRef<number | null>(null);

  const refocusTask = useCallback(() => {
    const id = refocusTaskId.current;
    if (id === null) return;
    const active = document.activeElement;
    // Focus is still on the old card, which may be about to remount. Keep waiting.
    if (active?.closest(`[data-task-id="${id}"]`)) return;
    // The user has moved on. Leave their focus alone.
    if (active !== document.body) {
      refocusTaskId.current = null;
      return;
    }
    const button = document.querySelector<HTMLElement>(`[data-task-id="${id}"] .card-open`);
    if (button) {
      button.focus();
      refocusTaskId.current = null;
    }
  }, []);

  useEffect(refocusTask, [tasks, refocusTask]);

  const closeTaskDialog = (taskId: number) => () => {
    setDialog(null);
    refocusTaskId.current = taskId;
    requestAnimationFrame(refocusTask);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2.5">
        <h1 className="mr-2 flex items-center gap-1.5 text-base font-semibold tracking-tight">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-primary" />
          Dot
        </h1>

        {projects && projects.length > 0 && projectId !== null && (
          <>
            <Select value={String(projectId)} onValueChange={(value) => selectProject(Number(value))}>
              <SelectTrigger aria-label="Project" className="min-w-48">
                <FolderGit2 aria-hidden="true" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {project && (
              <Button variant="ghost" onClick={() => setDialog({ kind: "project", project })}>
                <Settings aria-hidden="true" />
                Settings
              </Button>
            )}
          </>
        )}

        <span className="flex-1" />
        <Button variant="outline" onClick={() => setDialog({ kind: "new-project" })}>
          New project
        </Button>
        {project && (
          <Button onClick={() => setDialog({ kind: "new-task" })}>
            <Plus aria-hidden="true" />
            New task
          </Button>
        )}
      </header>

      {error && (
        <div className="px-4 pt-3">
          <Alert variant="destructive" className="flex items-start justify-between gap-3">
            <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={() => setError(null)}>
              <X aria-hidden="true" />
            </Button>
          </Alert>
        </div>
      )}

      {projects === null ? null : project ? (
        <Board
          tasks={tasks}
          onOpenTask={(task) => setDialog({ kind: "task", taskId: task.id })}
          onMove={moveTask}
          announce={announce}
        />
      ) : (
        <main className="mx-auto grid max-w-md justify-items-start gap-3 px-6 py-16">
          <h2 className="text-lg font-semibold">Add a project to start</h2>
          <p className="text-sm text-muted-foreground">
            A project points Dot at a git repo on this machine. Agents will work in worktrees of that repo.
          </p>
          <Button onClick={() => setDialog({ kind: "new-project" })}>
            <Plus aria-hidden="true" />
            Add project
          </Button>
        </main>
      )}

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {dialog?.kind === "new-task" && projectId !== null && <TaskDialog projectId={projectId} onClose={closeDialog} />}
      {openTask && <TaskSheet key={openTask.id} task={openTask} onClose={closeTaskDialog(openTask.id)} />}
      {(dialog?.kind === "new-project" || dialog?.kind === "project") && (
        <ProjectDialog
          project={dialog.kind === "project" ? dialog.project : null}
          onClose={closeDialog}
          onSaved={(saved) => selectProject(saved.id)}
        />
      )}
    </div>
  );
}
