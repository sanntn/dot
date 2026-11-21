import type { Schedule, Task } from "@dot/shared";
import type { EventBus } from "./events.ts";
import type { Store } from "./store.ts";

// Makes a task from each schedule when its time comes and starts the task's research. The orchestrator's
// agent limit applies as usual, so a firing waits in its queue when every slot is busy.

export type SchedulerDeps = {
  store: Store;
  bus: EventBus;
  // Starts the research of a task the scheduler just made.
  start: (taskId: number) => void;
};

const TICK_MS = 30_000;

export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  // Fires every schedule that is due. Returns the tasks it made.
  tick(at: Date = new Date()): Task[] {
    const made: Task[] = [];
    for (const schedule of this.deps.store.dueSchedules(at)) {
      try {
        const task = this.fire(schedule, at, { manual: false });
        if (task) made.push(task);
      } catch (err) {
        // One broken schedule must not stop the others. Note it and plan the next firing.
        this.deps.store.recordFiring(schedule.id, {
          at,
          taskId: null,
          note: `Could not create the task: ${err instanceof Error ? err.message : String(err)}`,
          manual: false,
        });
      }
    }
    return made;
  }

  // The "Run now" button. It makes a task even while the last one is open, and keeps the planned time.
  runNow(id: number, at: Date = new Date()): Task {
    const task = this.fire(this.deps.store.getSchedule(id), at, { manual: true });
    if (!task) throw new Error("A manual run always makes a task");
    return task;
  }

  private fire(schedule: Schedule, at: Date, { manual }: { manual: boolean }): Task | null {
    const { store, bus } = this.deps;
    // Skip while the last task is still open, so a slow task does not pile up copies of itself.
    if (!manual && schedule.lastTaskId !== null) {
      const previous = store.findTask(schedule.lastTaskId);
      if (previous && previous.column !== "done") {
        store.recordFiring(schedule.id, { at, taskId: null, note: `Skipped. #${previous.number} is not done yet, so it may be waiting for you.`, manual });
        // The skip shows on the schedule row, so tell open boards and dialogs to look again.
        bus.publish({ type: "tasks.changed", projectId: schedule.projectId });
        return null;
      }
    }

    const task = store.createTask({
      projectId: schedule.projectId,
      title: `${schedule.title} (${localDate(at)})`,
      description: schedule.description,
      kind: schedule.kind,
      blockedBy: [],
      autoStart: false,
    });
    // The task exists now, so nothing after this may throw, or the firing would not link to it.
    try {
      store.addMessage({
        taskId: task.id,
        runId: null,
        role: "system",
        kind: "status",
        text: `Created by the schedule "${schedule.name}".`,
      });
      bus.publish({ type: "tasks.changed", projectId: task.projectId, taskId: task.id });
    } catch (err) {
      console.error(`Schedule ${schedule.id}: could not note task ${task.id}:`, err);
    }

    let note = `Made #${task.number}.`;
    try {
      this.deps.start(task.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      store.addMessage({
        taskId: task.id,
        runId: null,
        role: "system",
        kind: "error",
        text: `Could not start the research by itself. Start it by hand.\n\n${reason}`,
      });
      note = `Made #${task.number}, but it did not start: ${reason}`;
    }
    store.recordFiring(schedule.id, { at, taskId: task.id, note, manual });
    return store.getTask(task.id);
  }

  // Checks on a timer. Returns the function that stops it.
  start(everyMs: number = TICK_MS): () => void {
    const timer = setInterval(() => this.tick(), everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
