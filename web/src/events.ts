import type { BoardEvent } from "@dot/shared";

// One EventSource for the whole page, shared by every component that listens.
// onOpen fires on every connect and reconnect, so listeners can refetch anything missed while
// disconnected. A listener added while already connected gets no onOpen: it loads its own data.

type Listener = { onEvent?: (event: BoardEvent) => void; onOpen?: () => void };

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let closeTimer: number | undefined;

function connect() {
  window.clearTimeout(closeTimer);
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    for (const l of listeners) l.onOpen?.();
  };
  source.onmessage = (e) => {
    const event = JSON.parse(e.data as string) as BoardEvent;
    for (const l of listeners) l.onEvent?.(event);
  };
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    // Wait a tick, so a component that unsubscribes and resubscribes in one render keeps the connection.
    if (listeners.size === 0) {
      closeTimer = window.setTimeout(() => {
        if (listeners.size > 0) return;
        source?.close();
        source = null;
      }, 0);
    }
  };
}

// Runs an async loader so calls never overlap. A call made while one is running
// schedules exactly one more run, so the last state always wins and old responses can't overwrite it.
export function serialLoader(load: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await load();
      } while (again);
    } finally {
      running = false;
    }
  };
  return () => void run();
}
