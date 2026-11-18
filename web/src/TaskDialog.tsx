import { IMAGE_TYPES, MAX_BATCH, type Task, type TaskTemplate } from "@dot/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "./api.ts";
import { parseList } from "./pasteList.ts";

// Creates a task, or several from a pasted list. Editing happens in the task panel's Details tab.
// Mounted to open. onClose runs after the close animation, when the parent can unmount it.
const MAX_IMAGES = 5;

export function TaskDialog(props: {
  projectId: number;
  tasks: Task[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<"one" | "list">("one");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [fill, setFill] = useState({ n: 0, title: "", description: "" });
  const [blockers, setBlockers] = useState<number[]>([]);
  const [images, setImages] = useState<File[]>([]);
  const [list, setList] = useState("");
  const [templateName, setTemplateName] = useState("");

  const openTasks = props.tasks.filter((t) => t.column !== "done");
  const parsed = parseList(list);

  useEffect(() => {
    let alive = true;
    api.listTemplates(props.projectId).then(
      (found) => alive && setTemplates(found),
      () => {
        // Templates are optional. The form works without them.
      },
    );
    return () => {
      alive = false;
    };
  }, [props.projectId]);

  function pickTemplate(value: string) {
    setTemplateId(value);
    const template = templates.find((t) => String(t.id) === value);
    if (template) setFill((f) => ({ n: f.n + 1, title: template.title, description: template.description }));
  }

  async function saveTemplate() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    setError(null);
    try {
      const saved = await api.addTemplate(props.projectId, {
        name: templateName,
        title: String(data.get("title") ?? ""),
        description: String(data.get("description") ?? ""),
      });
      setTemplates((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
      setTemplateId(String(saved.id));
      setTemplateName("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeTemplate() {
    const target = templateId;
    if (!target) return;
    try {
      await api.deleteTemplate(Number(target));
      setTemplates((prev) => prev.filter((t) => String(t.id) !== target));
      setTemplateId("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function addImages(files: FileList | null) {
    if (!files) return;
    const picked = [...files].filter((f) => (IMAGE_TYPES as readonly string[]).includes(f.type));
    if (picked.length < files.length) setError("Only PNG, JPEG, GIF and WebP images can be attached.");
    else setError(null);
    setImages((prev) => [...prev, ...picked].slice(0, MAX_IMAGES));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "list") {
        await api.createTasks(props.projectId, parsed.titles);
      } else {
        const form = new FormData(e.currentTarget);
        const task = await api.createTask({
          projectId: props.projectId,
          title: String(form.get("title") ?? ""),
          description: String(form.get("description") ?? ""),
          blockedBy: blockers,
        });
        const failed: string[] = [];
        for (const file of images) {
          try {
            await api.uploadAttachment(task.id, file, "task");
          } catch {
            failed.push(file.name);
          }
        }
        if (failed.length > 0) props.onError(`The task was created, but these images did not upload: ${failed.join(", ")}.`);
      }
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={props.onClose}>
        <form ref={formRef} className="grid gap-5" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>New tasks start in the Inbox. Open one and start research when it's ready.</DialogDescription>
          </DialogHeader>

          <Tabs value={mode} onValueChange={(v) => setMode(v as "one" | "list")}>
            <TabsList>
              <TabsTrigger value="one">One task</TabsTrigger>
              <TabsTrigger value="list">Paste a list</TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === "one" ? (
            <>
              {templates.length > 0 && (
                <div className="grid gap-2">
                  <Label htmlFor={`${id}-template`}>Template</Label>
                  <div className="flex gap-2">
                    <Select value={templateId} onValueChange={pickTemplate}>
                      <SelectTrigger id={`${id}-template`} className="flex-1">
                        <SelectValue placeholder="Start from a template" />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.map((t) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {templateId && (
                      <Button type="button" variant="outline" onClick={() => void removeTemplate()}>
                        Delete template
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <TaskFields key={fill.n} id={id} title={fill.title} description={fill.description} />

              {openTasks.length > 0 && (
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">Blocked by</legend>
                  <p className="text-xs text-muted-foreground">The task cannot start until these are done.</p>
                  <ul className="grid max-h-32 gap-1 overflow-y-auto rounded-md border p-2">
                    {openTasks.map((t) => (
                      <li key={t.id}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={blockers.includes(t.id)}
                            onChange={(e) =>
                              setBlockers((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id)))
                            }
                          />
                          <span className="tabular-nums text-muted-foreground">#{t.number}</span>
                          <span className="truncate">{t.title}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}

              <div className="grid gap-2">
                <Label htmlFor={`${id}-images`}>Images</Label>
                <Input
                  id={`${id}-images`}
                  type="file"
                  accept={IMAGE_TYPES.join(",")}
                  multiple
                  disabled={images.length >= MAX_IMAGES}
                  onChange={(e) => {
                    addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  The researcher sees these with the description. Up to {MAX_IMAGES}, 5 MB each.
                </p>
                {images.length > 0 && (
                  <ul className="grid gap-1 text-sm">
                    {images.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2">
                        <span className="truncate">{f.name}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor={`${id}-template-name`}>Save as a template</Label>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-template-name`}
                    value={templateName}
                    maxLength={100}
                    placeholder="Template name"
                    onChange={(e) => setTemplateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (templateName.trim()) void saveTemplate();
                      }
                    }}
                  />
                  <Button type="button" variant="outline" disabled={!templateName.trim()} onClick={() => void saveTemplate()}>
                    Save template
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-list`}>One task per line</Label>
              <Textarea
                id={`${id}-list`}
                rows={10}
                value={list}
                onChange={(e) => setList(e.target.value)}
                placeholder={"Fix the login redirect\nAdd a dark mode toggle\n- Bullets and numbers are fine too"}
                className="max-h-72"
              />
              <p className="text-xs text-muted-foreground" role="status">
                {parsed.titles.length === 0
                  ? "Nothing to add yet."
                  : `${parsed.titles.length} ${parsed.titles.length === 1 ? "task" : "tasks"} will be added to the Inbox.`}
                {parsed.tooMany && ` Only the first ${MAX_BATCH} are added.`}
              </p>
            </div>
          )}

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
            <Button type="submit" disabled={busy || (mode === "list" && parsed.titles.length === 0)}>
              {mode === "list" ? "Add tasks" : "Create task"}
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
