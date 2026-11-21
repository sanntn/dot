import { FREQUENCIES, kindDef, taskKindsFor, type Frequency, type ProjectKind, type Schedule, type TaskKind } from "@dot/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "./api.ts";
import { subscribe } from "./events.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FREQUENCY_LABELS: Record<Frequency, string> = { hourly: "Every hour", daily: "Every day", weekly: "Every week" };

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const two = (n: number) => String(n).padStart(2, "0");

// "Every day at 09:00", "Every week on Monday at 09:00", "Every hour at :15".
export function describeRhythm(s: Pick<Schedule, "frequency" | "hour" | "minute" | "weekday">): string {
  if (s.frequency === "hourly") return `Every hour at :${two(s.minute)}`;
  const time = `${two(s.hour)}:${two(s.minute)}`;
  return s.frequency === "weekly" ? `Every week on ${WEEKDAYS[s.weekday]} at ${time}` : `Every day at ${time}`;
}

// The browser's zone, shown as a hint. Times follow the server's zone, which is the same when Dot runs on your machine.
const zone = new Date().toLocaleTimeString(undefined, { timeZoneName: "short" }).split(" ").pop();

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Schedules make a task on a rhythm and start its research. The project's task budget caps what each one spends.
export function SchedulesSection({ projectId, projectKind, taskBudgetUsd = null }: { projectId: number; projectKind: ProjectKind; taskBudgetUsd?: number | null }) {
  const kinds = taskKindsFor(projectKind);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>("daily");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.listSchedules(projectId).then(
        (found) => alive && setSchedules(found),
        (err) => alive && setError(errorMessage(err)),
      );
    void load();
    // A firing or a skip changes Next and Last while the dialog is open.
    const unsubscribe = subscribe({ onEvent: (e) => e.type === "tasks.changed" && e.projectId === projectId && void load() });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [projectId]);

  async function act(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const replace = (saved: Schedule) => setSchedules((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));

  const toggle = (s: Schedule) => act(async () => replace(await api.updateSchedule(s.id, { enabled: !s.enabled })));
  const remove = (s: Schedule) =>
    act(async () => {
      await api.deleteSchedule(s.id);
      setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    });
  const runNow = (s: Schedule) => act(async () => replace((await api.runSchedule(s.id)).schedule));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    // Hourly asks only for the minute. The others ask for a time of day.
    const time = String(form.get("time") || "");
    const [hour = "9", minute = "0"] = frequency === "hourly" ? ["0", time || "0"] : time.split(":");
    void act(async () => {
      const saved = await api.addSchedule(projectId, {
        name: String(form.get("name") ?? ""),
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        kind: String(form.get("kind")) as TaskKind,
        frequency,
        hour: Number(hour),
        minute: Number(minute),
        weekday: Number(form.get("weekday") ?? 1),
      });
      setSchedules((prev) => [...prev, saved]);
      setAdding(false);
    });
  }

  return (
    <section className="grid gap-2" aria-labelledby="schedules-heading">
      <h3 id="schedules-heading" className="text-sm font-semibold">
        Schedules
      </h3>
      <p className="text-sm text-muted-foreground">
        A schedule makes a task and starts its research on a rhythm, in the server's time zone (this browser is in {zone}). It skips a round while its last task is not done.
        The project's task budget caps what each run spends.
      </p>

      {taskBudgetUsd === null && (
        <p role="note" className="text-sm text-amber-600 dark:text-amber-400">
          This project has no task budget, so scheduled runs can spend without a limit. Set one in the project's settings.
        </p>
      )}
      {schedules.length === 0 && !adding && <p className="text-sm text-muted-foreground">No schedules in this project.</p>}
      {schedules.length > 0 && (
        <ul className="grid gap-2">
          {schedules.map((s) => (
            <li key={s.id} className="grid gap-1 rounded-lg border p-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {s.name} <span className="font-normal text-muted-foreground">({kindDef(s.kind).label})</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {describeRhythm(s)}. {s.enabled && s.nextRunAt ? `Next ${formatWhen(s.nextRunAt)}.` : "Off."}
                  </div>
                  {s.lastRunAt && (
                    <div className={s.lastNote.startsWith("Skipped") ? "text-xs text-amber-600 dark:text-amber-400" : "text-xs text-muted-foreground"}>
                      Last {formatWhen(s.lastRunAt)}. {s.lastNote}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="outline" size="xs" disabled={busy} onClick={() => void runNow(s)}>
                    Run now
                  </Button>
                  <Button variant="outline" size="xs" disabled={busy} aria-pressed={s.enabled} onClick={() => void toggle(s)}>
                    {s.enabled ? "Turn off" : "Turn on"}
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy} aria-label={`Delete schedule ${s.name}`} onClick={() => void remove(s)}>
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="grid gap-2 rounded-lg border p-2" onSubmit={onSubmit}>
          <div className="grid gap-1">
            <Label htmlFor="schedule-name">Name</Label>
            <Input id="schedule-name" name="name" required maxLength={100} placeholder="Monday digest" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="schedule-kind">Kind</Label>
            <select id="schedule-kind" name="kind" className={selectClass} defaultValue={kinds.includes("report") ? "report" : kinds[0]}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {kindDef(k).label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="schedule-title">Task title</Label>
            <Input id="schedule-title" name="title" required maxLength={200} placeholder="Weekly digest" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="schedule-description">Brief</Label>
            <textarea
              id="schedule-description"
              name="description"
              rows={3}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              placeholder="What each task should do"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="schedule-frequency">Repeats</Label>
              <select id="schedule-frequency" className={selectClass} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="schedule-time">{frequency === "hourly" ? "Minute past the hour" : "At"}</Label>
              {frequency === "hourly" ? (
                <Input id="schedule-time" name="time" type="number" min={0} max={59} defaultValue={0} required />
              ) : (
                <Input id="schedule-time" name="time" type="time" defaultValue="09:00" required />
              )}
            </div>
          </div>
          {frequency === "weekly" && (
            <div className="grid gap-1">
              <Label htmlFor="schedule-weekday">On</Label>
              <select id="schedule-weekday" name="weekday" className={selectClass} defaultValue={1}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} loading={busy}>
              Add schedule
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" onClick={() => setAdding(true)}>
            Add a schedule
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
