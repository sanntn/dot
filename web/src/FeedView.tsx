import { COLUMN_LABELS, kindDef, type FeedItem, type Project } from "@dot/shared";
import { useState } from "react";
import { api } from "./api.ts";
import { ScopeSelect, scopeProjectId, useScope } from "./ScopeSelect.tsx";
import { useLive } from "./useLive.ts";

function describe(item: FeedItem): string {
  switch (item.event) {
    case "created":
      return item.schedule ? `Made by the schedule "${item.schedule}"` : "Created";
    case "needs_you":
      return "Asked for you";
    case "failed":
      return "Failed";
    case "moved":
      return item.detail === "done" ? "Finished" : `Reached ${item.detail ? COLUMN_LABELS[item.detail] : "a new column"}`;
  }
}

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

// What happened to tasks, newest first. Turn on "Scheduled jobs only" to read the digest of recurring runs.
export function FeedView(props: { projects: Project[]; currentId: number | null; onOpen: (projectId: number, taskId: number) => void }) {
  const [scope, setScope] = useScope(props.currentId);
  const [scheduledOnly, setScheduledOnly] = useState(false);
  const { data: items, error } = useLive(() => api.feed({ projectId: scopeProjectId(scope), scheduledOnly }), [scope, scheduledOnly]);

  const days: { day: string; items: FeedItem[] }[] = [];
  for (const item of items ?? []) {
    const day = dayLabel(item.at);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }

  return (
    <main className="mx-auto grid w-full max-w-3xl content-start gap-4 overflow-y-auto px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Feed</h2>
          <p className="text-sm text-muted-foreground">What happened to tasks: made, waiting for you, failed, finished.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={scheduledOnly} onChange={(e) => setScheduledOnly(e.target.checked)} />
            Scheduled jobs only
          </label>
          <ScopeSelect projects={props.projects} value={scope} onChange={setScope} />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!items && !error && <p className="text-sm text-muted-foreground">Loading...</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{scheduledOnly ? "No scheduled job has run yet. Add one in Preferences." : "Nothing has happened yet."}</p>
      )}

      {days.map(({ day, items: rows }) => (
        <section key={day} className="grid gap-1" aria-label={day}>
          <h3 className="text-xs font-medium text-muted-foreground">{day}</h3>
          <ul className="grid">
            {rows.map((item, i) => (
              <li key={`${item.taskId}-${item.at}-${i}`} className="border-t py-2 text-sm first:border-t-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <button type="button" className="text-left font-medium hover:underline focus-visible:underline [overflow-wrap:anywhere]" onClick={() => props.onOpen(item.projectId, item.taskId)}>
                    #{item.number} {item.title}
                  </button>
                  <time dateTime={item.at} className="text-xs text-muted-foreground">
                    {new Date(item.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </time>
                </div>
                <div className="text-muted-foreground">
                  {describe(item)}. {kindDef(item.kind).label}
                  {scope === "all" && props.projects.length > 1 ? ` in ${item.projectName}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
