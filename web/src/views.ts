// The screens of the app. The board is the main one. The others look across tasks.
export const VIEWS = ["board", "documents", "triage", "feed", "outputs"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = {
  board: "Board",
  documents: "Documents",
  triage: "Triage",
  feed: "Feed",
  outputs: "Outputs",
};

const KEY = "dot.view";

export function readStoredView(): View {
  try {
    const value = localStorage.getItem(KEY);
    return (VIEWS as readonly string[]).includes(value ?? "") ? (value as View) : "board";
  } catch {
    return "board";
  }
}

export function storeView(view: View) {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // Storage can be blocked. The view still changes, it just is not remembered.
  }
}
