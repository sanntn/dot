import { AGENT_STAGES, COLUMN_LABELS, STAGE_LABELS, type ChatMessage, type Run, type TaskEvent } from "@dot/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";

// Cost and a timeline for one task, built from the runs and messages the task panel already loads.

type Entry = { at: string; label: string; detail?: string; tone?: "error" };

const MESSAGE_LABEL: Partial<Record<ChatMessage["kind"], string>> = {
  plan: "Plan submitted",
  report: "Execution report submitted",
  review: "Review submitted",
  question: "The agent asked a question",
  error: "Error",
};

function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function eventEntry(e: TaskEvent): Entry {
  if (e.kind === "moved") return { at: e.createdAt, label: `Moved to ${COLUMN_LABELS[e.detail as keyof typeof COLUMN_LABELS] ?? e.detail}` };
  if (e.kind === "needs_you") return { at: e.createdAt, label: "Needs you" };
  return { at: e.createdAt, label: "The agent stopped with an error", tone: "error" };
}

function entries(runs: Run[], messages: ChatMessage[], events: TaskEvent[]): Entry[] {
  const list: Entry[] = events.map(eventEntry);
  for (const run of runs) {
    const name = STAGE_LABELS[run.stage];
    list.push({ at: run.createdAt, label: `${name} started` });
    if (run.status === "failed") {
      list.push({ at: run.updatedAt, label: `${name} failed`, detail: run.error ? clip(run.error) : undefined, tone: "error" });
    }
  }
  for (const m of messages) {
    if (m.role === "user" && m.kind === "text") {
      list.push({ at: m.createdAt, label: "You wrote", detail: clip(m.text) });
    } else if (m.kind === "status") {
      list.push({ at: m.createdAt, label: clip(m.text, 100) });
    } else {
      const label = MESSAGE_LABEL[m.kind];
      if (label) list.push({ at: m.createdAt, label, detail: m.text ? clip(m.text) : undefined, tone: m.kind === "error" ? "error" : undefined });
    }
  }
  return list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function dollars(value: number): string {
  return value > 0 && value < 0.01 ? "< $0.01" : `$${value.toFixed(2)}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ActivityPanel({ taskId, runs, messages }: { taskId: number; runs: Run[]; messages: ChatMessage[] }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  // Runs and messages change whenever the task does, so they double as the refetch trigger.
  useEffect(() => {
    let alive = true;
    api.listEvents(taskId).then(
      (found) => alive && setEvents(found),
      () => {
        // The timeline still shows runs and messages without the event log.
      },
    );
    return () => {
      alive = false;
    };
  }, [taskId, runs, messages]);
  const timeline = useMemo(() => entries(runs, messages, events), [runs, messages, events]);
  const byStage = AGENT_STAGES.map((stage) => {
    const own = runs.filter((r) => r.stage === stage);
    return { stage, count: own.length, cost: own.reduce((sum, r) => sum + r.costUsd, 0) };
  }).filter((row) => row.count > 0);
  const total = byStage.reduce((sum, row) => sum + row.cost, 0);

  return (
    <div className="grid gap-6 p-4">
      <section aria-labelledby="cost-heading" className="grid gap-2">
        <h3 id="cost-heading" className="text-sm font-semibold">
          Cost
        </h3>
        {byStage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent has run on this task yet.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              What this usage would cost at API prices. Your subscription covers it.
            </p>
            <table className="w-full text-sm">
              <thead className="sr-only">
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {byStage.map((row) => (
                  <tr key={row.stage} className="border-b">
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {STAGE_LABELS[row.stage]}
                    </th>
                    <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                      {row.count} {row.count === 1 ? "run" : "runs"}
                    </td>
                    <td className="py-1.5 pl-4 text-right tabular-nums">{dollars(row.cost)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-1.5 text-left font-medium">
                    Total
                  </th>
                  <td />
                  <td className="py-1.5 pl-4 text-right font-medium tabular-nums">{dollars(total)}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-labelledby="timeline-heading" className="grid gap-2">
        <h3 id="timeline-heading" className="text-sm font-semibold">
          Timeline
        </h3>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
        ) : (
          <ol className="grid gap-3">
            {timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} className="grid grid-cols-[7.5rem_1fr] gap-3 text-sm">
                <time dateTime={e.at} className="text-xs text-muted-foreground tabular-nums">
                  {timeFormat.format(new Date(e.at))}
                </time>
                <div className="min-w-0">
                  <p className={e.tone === "error" ? "text-destructive" : undefined}>{e.label}</p>
                  {e.detail && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{e.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
