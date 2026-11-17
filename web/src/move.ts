import type { Task, TaskMove } from "@dot/shared";

export const byPosition = (a: Task, b: Task) => a.position - b.position;

// Same ordering rule as the server's moveTask, applied locally so the board updates before the request returns.
export function applyMove(tasks: Task[], id: number, move: TaskMove): Task[] {
  const task = tasks.find((t) => t.id === id);
  if (!task) return tasks;

  const target = tasks.filter((t) => t.column === move.column && t.id !== id).sort(byPosition);
  const found = move.beforeTaskId === null ? -1 : target.findIndex((t) => t.id === move.beforeTaskId);
  target.splice(found === -1 ? target.length : found, 0, { ...task, column: move.column });

  const updated = new Map(target.map((t, i) => [t.id, { ...t, position: (i + 1) * 1024 }]));
  return tasks.map((t) => updated.get(t.id) ?? t);
}
