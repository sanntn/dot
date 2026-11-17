import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "./api.ts";

// Creates a task. Editing happens in the task panel's Details tab.
// Mounted to open. onClose runs after the close animation, when the parent can unmount it.
export function TaskDialog(props: { projectId: number; onClose: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api.createTask({
        projectId: props.projectId,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
      });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={props.onClose}>
        <form className="grid gap-5" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>New tasks start in the Inbox. Open one and start research when it's ready.</DialogDescription>
          </DialogHeader>
          <TaskFields id={id} />
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskFields(props: { id: string; title?: string; description?: string }) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${props.id}-title`}>Title</Label>
        <Input id={`${props.id}-title`} name="title" required maxLength={200} defaultValue={props.title} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${props.id}-description`}>Description</Label>
        <Textarea
          id={`${props.id}-description`}
          name="description"
          rows={8}
          maxLength={20000}
          defaultValue={props.description}
          placeholder="What should be done, and why. The research agent starts from this."
          className="max-h-80"
        />
      </div>
    </>
  );
}
