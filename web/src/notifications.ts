import type { Task } from "@dot/shared";
import { useEffect, useRef } from "react";
import { laneOf } from "./lanes.ts";

const KEY = "dot.notifications";

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1" && notificationsSupported() && Notification.permission === "granted";
  } catch {
    return false;
  }
}

// Turning on asks the browser for permission. Returns whether notifications are now on.
export async function setNotifications(on: boolean): Promise<boolean> {
  let enabled = on;
  if (on) {
    if (!notificationsSupported()) return false;
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    enabled = permission === "granted";
  }
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // Storage can be blocked. The setting then lasts until the page reloads.
  }
  return enabled;
}

// Notifies when a task newly enters Needs you while the tab is in the background.
export function useNeedsYouNotifications(tasks: Task[], onOpen: (task: Task) => void) {
  const seen = useRef<Set<number> | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    const now = new Set(tasks.filter((t) => laneOf(t) === "needs_you").map((t) => t.id));
    const before = seen.current;
    seen.current = now;
    // The first list is the baseline. Only later arrivals notify.
    if (before === null || !document.hidden || !notificationsEnabled()) return;
    for (const task of tasks) {
      if (!now.has(task.id) || before.has(task.id)) continue;
      const note = new Notification(`#${task.number} needs you`, { body: task.title, tag: `dot-task-${task.id}` });
      note.onclick = () => {
        window.focus();
        open.current(task);
        note.close();
      };
    }
  }, [tasks]);
}
