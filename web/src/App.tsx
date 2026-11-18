import type { Project, Task, TaskMove } from "@dot/shared";
import { Ellipsis, FolderGit2, FolderPlus, Plus, Search, Settings, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errorMessage } from "./api.ts";
import { Board } from "./Board.tsx";
import { buildCommands, CommandMenu } from "./CommandMenu.tsx";
import { subscribe } from "./events.ts";
import { applyMove } from "./move.ts";
import { ProjectDialog } from "./ProjectDialog.tsx";
import { TaskDialog } from "./TaskDialog.tsx";
import { TaskSheet } from "./TaskSheet.tsx";
import { canRetry, laneOf } from "./lanes.ts";
import { ShortcutsDialog } from "./ShortcutsDialog.tsx";
import { useShortcuts } from "./shortcuts.ts";
import { tightest, UsageSection, useClaudeUsage } from "./UsageLimits.tsx";

type OpenDialog =
  | { kind: "new-task" }
  | { kind: "task"; taskId: number }
  | { kind: "shortcuts" }
  | { kind: "command" }
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

  // The tab title counts what waits for you, so it shows from another tab.
  const waiting = tasks.filter((t) => laneOf(t) === "needs_you").length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Dot` : "Dot";
  }, [waiting]);

  const openNewTask = useCallback(() => setDialog({ kind: "new-task" }), []);
  const openShortcuts = useCallback(() => setDialog({ kind: "shortcuts" }), []);
  const openCommands = useCallback(() => setDialog({ kind: "command" }), []);

  // Board actions. They share one error path, and the board refetches on the server's events.
  const [deleting, setDeleting] = useState<Task | null>(null);
  const act = useCallback(async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  const startTask = useCallback((task: Task) => act(() => api.startTask(task.id)), [act]);
  const stopTask = useCallback((task: Task) => act(() => api.stopTask(task.id)), [act]);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const approveFocused = useCallback(
    (id: number) => {
      const task = tasksRef.current.find((t) => t.id === id);
      if (task?.column !== "plan_review") return;
      void act(() => api.approvePlan(id));
      announce(`Approved the plan for ${task.title}.`);
    },
    [act, announce],
  );
  const retryFocused = useCallback(
    (id: number) => {
      const task = tasksRef.current.find((t) => t.id === id);
      if (!task || !canRetry(task)) return;
      void act(() => api.startTask(id));
      announce(`Retrying ${task.title}.`);
    },
    [act, announce],
  );

  useShortcuts({
    newTask: project ? openNewTask : null,
    help: openShortcuts,
    search: openCommands,
    approve: approveFocused,
    retry: retryFocused,
    enabled: dialog === null && deleting === null,
  });

  const usageState = useClaudeUsage(project?.claudeConfigDir ?? null, project?.claudeToken ?? null, project !== null);
  const worst = tightest(usageState.usage);
  const usageAlert = worst !== null && worst.severity !== "normal" ? worst : null;

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
          </>
        )}

        <span className="flex-1" />
        <Button variant="outline" onClick={openCommands} aria-label="Search and commands, Control K" title="Ctrl K">
          <Search aria-hidden="true" />
          <span className="hidden sm:inline">Search</span>
        </Button>
        {project && (
          <Button onClick={() => setDialog({ kind: "new-task" })}>
            <Plus aria-hidden="true" />
            New task
          </Button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="relative"
              aria-label={
                usageAlert
                  ? `More: projects, settings, Claude limits, ${Math.round(usageAlert.percent)}% used`
                  : "More: projects, settings, Claude limits"
              }
            >
              <Ellipsis aria-hidden="true" />
              {usageAlert && (
                <span
                  aria-hidden="true"
                  className={`absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-background ${usageAlert.severity === "critical" ? "bg-destructive" : "bg-amber-500"}`}
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="end">
            <div className="grid gap-0.5 p-1">
            <Button variant="ghost" className="justify-start" onClick={() => setDialog({ kind: "new-project" })}>
              <FolderPlus aria-hidden="true" />
              New project
            </Button>
            {project && (
              <Button variant="ghost" className="justify-start" onClick={() => setDialog({ kind: "project", project })}>
                <Settings aria-hidden="true" />
                Settings
              </Button>
            )}
            </div>
            <UsageSection state={usageState} />
          </PopoverContent>
        </Popover>
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
          onStart={startTask}
          onStop={stopTask}
          onDelete={setDeleting}
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
      {dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={closeDialog} />}
      {dialog?.kind === "command" && (
        <CommandMenu
          onClose={closeDialog}
          items={buildCommands({
            tasks,
            projects: projects ?? [],
            projectId,
            newTask: project ? openNewTask : null,
            shortcuts: openShortcuts,
            openTask: (task) => setDialog({ kind: "task", taskId: task.id }),
            selectProject,
          })}
        />
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? `#${deleting.number} ${deleting.title}` : ""} will be removed, with its chat, plan and worktree.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const task = deleting;
                if (task) void act(() => api.deleteTask(task.id));
              }}
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
