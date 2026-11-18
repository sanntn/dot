import { useEffect } from "react";

// One list drives both the key handler and the help dialog, so they cannot drift apart.
export const SHORTCUTS = [
  { keys: ["N"], label: "New task" },
  { keys: ["J", "K"], label: "Next or previous card" },
  { keys: ["H", "L"], label: "Previous or next lane" },
  { keys: ["Enter"], label: "Open the focused card" },
  { keys: ["Alt", "Arrows"], label: "Move the focused card" },
  { keys: ["Esc"], label: "Close the panel" },
  { keys: ["?"], label: "Show this list" },
] as const;

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

// Cards in reading order, grouped by lane, so J/K and H/L can step through them.
function laneCards(): HTMLElement[][] {
  return [...document.querySelectorAll<HTMLElement>("[data-lane]")].map((lane) => [
    ...lane.querySelectorAll<HTMLElement>(".card-open"),
  ]);
}

function moveFocus(key: string) {
  const lanes = laneCards();
  const active = document.activeElement;
  let lane = lanes.findIndex((cards) => cards.some((c) => c === active || c.closest("li")?.contains(active)));
  let index = lane === -1 ? -1 : lanes[lane]!.findIndex((c) => c.closest("li")?.contains(active));

  if (key === "j" || key === "k") {
    if (lane === -1) lane = lanes.findIndex((cards) => cards.length > 0);
    const cards = lanes[lane];
    if (!cards?.length) return;
    index = key === "j" ? Math.min(index + 1, cards.length - 1) : Math.max(index - 1, 0);
    cards[index]?.focus();
    return;
  }

  // H and L jump to the nearest non-empty lane, keeping the row when it can.
  const step = key === "l" ? 1 : -1;
  for (let next = lane + step; next >= 0 && next < lanes.length; next += step) {
    const cards = lanes[next]!;
    if (cards.length > 0) {
      cards[Math.min(Math.max(index, 0), cards.length - 1)]?.focus();
      return;
    }
  }
  if (lane === -1) lanes.find((cards) => cards.length > 0)?.[0]?.focus();
}

export function useShortcuts(handlers: { newTask: (() => void) | null; help: () => void; enabled: boolean }) {
  const { newTask, help, enabled } = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      // Leave open panels and menus alone. They have their own keys.
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      const key = e.key.toLowerCase();
      if (key === "n" && newTask) newTask();
      else if (e.key === "?") help();
      else if ("jkhl".includes(key) && key.length === 1) moveFocus(key);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTask, help, enabled]);
}
