import type { ProjectKind, StorageReport, TaskTemplate } from "@dot/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "./api.ts";
import { setFullDetail, useFullDetail } from "./detail.tsx";
import { MemorySection } from "./MemorySection.tsx";
import { RulesSection } from "./RulesSection.tsx";
import { SchedulesSection } from "./SchedulesSection.tsx";
import { notificationsEnabled, notificationsSupported, setNotifications } from "./notifications.ts";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// What Dot keeps on the server's disk. This is not a per-browser setting, unlike the rest of this dialog.
function StorageSection() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freed, setFreed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getStorage().then(
      (found) => alive && setReport(found),
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, []);

  async function clean() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.cleanStorage();
      setFreed(`Removed ${result.removed} ${result.removed === 1 ? "folder" : "folders"}, freed ${formatBytes(result.freedBytes)}.`);
      setReport(await api.getStorage());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const worktreeBytes = report?.worktrees.reduce((sum, w) => sum + w.bytes, 0) ?? 0;
  const removable = report ? report.worktrees.filter((w) => w.removable).length + report.orphans.length : 0;
  const biggest = report ? [...report.worktrees].sort((a, b) => b.bytes - a.bytes).slice(0, 5) : [];

  return (
    <section className="grid gap-2" aria-labelledby="storage-heading">
      <h3 id="storage-heading" className="text-sm font-semibold">
        Disk space
      </h3>
      <p className="text-sm text-muted-foreground">
        What Dot keeps on the server. Cleaning removes the worktrees of finished tasks and folders no task owns. Branches stay in your repository.
      </p>
      {!report && !error && <p className="text-sm text-muted-foreground">Measuring...</p>}
      {report && (
        <>
          <ul className="grid gap-1 text-sm">
            <li className="flex justify-between gap-2">
              <span>Worktrees ({report.worktrees.length})</span>
              <span className="tabular-nums">{formatBytes(worktreeBytes)}</span>
            </li>
            {report.orphans.length > 0 && (
              <li className="flex justify-between gap-2">
                <span>Folders no task owns ({report.orphans.length})</span>
                <span className="tabular-nums">{formatBytes(report.orphans.reduce((s, o) => s + o.bytes, 0))}</span>
              </li>
            )}
            {report.other.map((o) => (
              <li key={o.label} className="flex justify-between gap-2">
                <span>{o.label}</span>
                <span className="tabular-nums">{formatBytes(o.bytes)}</span>
              </li>
            ))}
          </ul>
          {biggest.length > 0 && (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {biggest.map((w) => (
                <li key={w.taskId} className="flex justify-between gap-2">
                  <span className="truncate">
                    #{w.number} {w.title}
                    {w.removable ? ", done" : ""}
                  </span>
                  <span className="tabular-nums">{formatBytes(w.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <Button variant="outline" disabled={busy || removable === 0} onClick={() => void clean()}>
              Remove finished worktrees
            </Button>
            {freed && <span className="text-sm text-muted-foreground" role="status">{freed}</span>}
          </div>
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

export function PreferencesDialog({ projectId, projectKind = "repo", taskBudgetUsd = null, onClose }: { projectId: number | null; projectKind?: ProjectKind; taskBudgetUsd?: number | null; onClose: () => void }) {
  const [on, setOn] = useState(notificationsEnabled);
  const fullDetail = useFullDetail();
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const supported = notificationsSupported();
  const blocked = supported && Notification.permission === "denied";

  useEffect(() => {
    if (projectId === null) return;
    let alive = true;
    api.listTemplates(projectId).then(
      (found) => alive && setTemplates(found),
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function toggle() {
    setOn(await setNotifications(!on));
  }

  async function remove(id: number) {
    try {
      await api.deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>Notifications and detail apply to this browser. Rules, schedules and templates belong to the project.</DialogDescription>
        </DialogHeader>

        <section className="grid gap-2" aria-labelledby="notify-heading">
          <h3 id="notify-heading" className="text-sm font-semibold">
            Notifications
          </h3>
          <p className="text-sm text-muted-foreground">
            {!supported
              ? "This browser does not support notifications."
              : blocked
                ? "Notifications are blocked for this site. Allow them in the site settings of your browser."
                : "Get a desktop notification when a task needs you and this tab is in the background."}
          </p>
          <div>
            <Button variant="outline" disabled={!supported || blocked} aria-pressed={on} onClick={() => void toggle()}>
              {on ? "Turn off notifications" : "Turn on notifications"}
            </Button>
          </div>
        </section>

        <section className="grid gap-2" aria-labelledby="detail-heading">
          <h3 id="detail-heading" className="text-sm font-semibold">
            Detail
          </h3>
          <p className="text-sm text-muted-foreground">
            Plans, reports, reviews and chat replies show the main points first and fold the rest away. Turn this on to
            open everything by default.
          </p>
          <div>
            <Button variant="outline" aria-pressed={fullDetail} onClick={() => setFullDetail(!fullDetail)}>
              {fullDetail ? "Show main points only" : "Show full detail"}
            </Button>
          </div>
        </section>

        {projectId !== null && <RulesSection projectId={projectId} />}

        {projectId !== null && <MemorySection projectId={projectId} />}

        {projectId !== null && <SchedulesSection projectId={projectId} projectKind={projectKind} taskBudgetUsd={taskBudgetUsd} />}

        <StorageSection />

        <section className="grid gap-2" aria-labelledby="templates-heading">
          <h3 id="templates-heading" className="text-sm font-semibold">
            Task templates
          </h3>
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No templates in this project. Save one from the New task dialog.</p>
          ) : (
            <ul className="grid gap-1">
              {templates.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{t.name}</span>
                  <Button variant="ghost" size="xs" aria-label={`Delete template ${t.name}`} onClick={() => void remove(t.id)}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </section>
      </DialogContent>
    </Dialog>
  );
}
