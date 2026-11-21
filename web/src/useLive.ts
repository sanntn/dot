import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api.ts";
import { subscribe } from "./events.ts";
import { newestOnly } from "./newestOnly.ts";

// Loads what a view shows and loads it again when the board changes. `deps` are the filters: a change
// loads again, after `delay` ms so typing does not search on every key. Board events are agents at work
// and arrive in bursts, so one pause covers many. Only the newest request may set the data, so a slow
// earlier answer cannot overwrite a newer one.
export function useLive<T>(load: () => Promise<T>, deps: readonly unknown[], delay = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const guard = useRef(newestOnly());
  const alive = useRef(true);

  const run = useCallback(() => {
    const current = guard.current.next();
    loadRef.current().then(
      (found) => {
        if (alive.current && current()) (setData(found), setError(null));
      },
      (err) => {
        if (alive.current && current()) setError(errorMessage(err));
      },
    );
  }, []);

  // `data` keeps its last value while a new filter loads, so the list does not flash empty.
  useEffect(() => {
    alive.current = true;
    const timer = window.setTimeout(run, delay);
    return () => {
      alive.current = false;
      // An answer for the old filter must not show once the filter has changed.
      guard.current.invalidate();
      window.clearTimeout(timer);
    };
    // The filters are the dependencies. `delay` only changes with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps]);

  useEffect(() => {
    let timer: number | undefined;
    const stop = subscribe({
      onEvent: (e) => {
        if (e.type !== "tasks.changed") return;
        window.clearTimeout(timer);
        timer = window.setTimeout(run, 1000);
      },
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [run]);

  return { data, error, reload: run };
}
