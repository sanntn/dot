import { laneOf, type Task } from "@dot/shared";
import type { EventBus } from "./events.ts";
import type { Store } from "./store.ts";

// Tells a webhook when a task starts waiting for you, so you hear about it with the board closed.
// It works with ntfy, Slack, Discord and any endpoint that takes a JSON POST.

export type NotifyOptions = {
  url: string;
  // "json" sends an object with text, content and the task's fields. "text" sends the message as the
  // plain body with a Title header, which is what ntfy expects.
  format?: "json" | "text";
  // Base address of the board, for the link in the message. Left out when not set.
  appUrl?: string;
  // How long a task must still be waiting before Dot sends. Skips flickers and lets the question land.
  settleMs?: number;
  fetch?: typeof fetch;
};

function reason(task: Task, question: string | null): string {
  if (task.agentState === "failed") return "The agent stopped with an error.";
  if (task.needsInput) return question ? `The agent asks: ${question}` : "The agent asked you a question.";
  if (task.column === "plan_review") return "The plan is ready for you to review.";
  if (task.column === "report_review") return "The report is ready for you to read.";
  if (task.column === "merge_approval") return "The change is ready to merge when you approve.";
  return "It needs you.";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

// Starts watching. Returns a function that stops it.
export function startNotifier(
  store: Store,
  bus: EventBus,
  options: NotifyOptions,
  log: (message: string) => void = (m) => console.error(m),
): () => void {
  const send = options.fetch ?? fetch;
  const settleMs = options.settleMs ?? 2000;
  const format = options.format ?? "json";
  // Task ids that were already waiting. Only a task that joins the lane later sends a message.
  const waiting = new Set<number>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const link = (task: Task) => (options.appUrl ? `${options.appUrl.replace(/\/+$/, "")}/?project=${task.projectId}&task=${task.id}` : null);

  const deliver = async (taskId: number) => {
    timers.delete(taskId);
    let task: Task;
    try {
      task = store.getTask(taskId);
    } catch {
      return;
    }
    // The task moved on during the delay, so there is nothing to tell you.
    if (laneOf(task) !== "needs_you") return;
    // Only a question still waiting for you. A budget pause or a stuck agent has none to quote.
    const question = task.needsInput ? (store.latestOpenQuestion(taskId)?.text ?? null) : null;
    const project = store.getProject(task.projectId).name;
    const title = `${project} #${task.number} needs you`;
    const body = `${clip(task.title, 120)}\n${reason(task, question ? clip(question, 300) : null)}`;
    const url = link(task);
    try {
      const response =
        format === "text"
          ? await send(options.url, {
              method: "POST",
              headers: { Title: title, "Content-Type": "text/plain; charset=utf-8", ...(url ? { Click: url } : {}) },
              body: url ? `${body}\n${url}` : body,
            })
          : await send(options.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: `${title}\n${body}${url ? `\n${url}` : ""}`,
                content: `${title}\n${body}${url ? `\n${url}` : ""}`,
                event: "needs_you",
                project,
                task: { id: task.id, number: task.number, title: task.title, column: task.column },
                url,
              }),
            });
      if (!response.ok) log(`Notification webhook answered ${response.status}.`);
    } catch (err) {
      log(`Notification webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const check = (projectId: number) => {
    let tasks: Task[];
    try {
      tasks = store.listTasks(projectId);
    } catch {
      return;
    }
    for (const task of tasks) {
      const needsYou = laneOf(task) === "needs_you";
      if (needsYou && !waiting.has(task.id)) {
        waiting.add(task.id);
        timers.set(task.id, setTimeout(() => void deliver(task.id), settleMs));
      } else if (!needsYou && waiting.delete(task.id)) {
        // A task that left and comes back later should notify again. Drop a send that has not fired yet.
        const timer = timers.get(task.id);
        if (timer) clearTimeout(timer);
        timers.delete(task.id);
      }
    }
  };

  // The tasks already waiting at startup are the baseline.
  for (const project of store.listProjects()) {
    for (const task of store.listTasks(project.id)) if (laneOf(task) === "needs_you") waiting.add(task.id);
  }

  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "tasks.changed") check(event.projectId);
  });
  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
