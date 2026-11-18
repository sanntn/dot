import type { TaskTemplate } from "@dot/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "./api.ts";
import { notificationsEnabled, notificationsSupported, setNotifications } from "./notifications.ts";

export function PreferencesDialog({ projectId, onClose }: { projectId: number | null; onClose: () => void }) {
  const [on, setOn] = useState(notificationsEnabled);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>These apply to this browser.</DialogDescription>
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
