import { IMAGE_TYPES, type AttachmentRef } from "@dot/shared";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, attachmentUrl, errorMessage } from "./api.ts";

export const MAX_TASK_IMAGES = 5;

// The images attached to a task. The researcher sees them with the description.
export function TaskImages({ taskId, locked }: { taskId: number; locked: boolean }) {
  const id = useId();
  const [images, setImages] = useState<AttachmentRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listTaskImages(taskId).then(
      (found) => alive && setImages(found),
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [taskId]);

  async function add(files: FileList | null) {
    if (!files) return;
    const room = MAX_TASK_IMAGES - images.length;
    const picked = [...files].filter((f) => (IMAGE_TYPES as readonly string[]).includes(f.type)).slice(0, room);
    setError(picked.length < files.length ? "Only PNG, JPEG, GIF and WebP images fit, up to five in all." : null);
    setBusy(true);
    try {
      for (const file of picked) {
        const ref = await api.uploadAttachment(taskId, file, "task");
        setImages((prev) => [...prev, ref]);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(image: AttachmentRef) {
    try {
      await api.deleteTaskImage(image.id);
      setImages((prev) => prev.filter((i) => i.id !== image.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor={`${id}-images`}>Images</Label>
      <p className="-mt-1 text-xs text-muted-foreground">
        The researcher sees these with the description when research starts. Up to {MAX_TASK_IMAGES}, 5 MB each.
      </p>
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {images.map((image) => (
            <li key={image.id} className="grid justify-items-start gap-1">
              <a href={attachmentUrl(image.id)} target="_blank" rel="noreferrer">
                <img src={attachmentUrl(image.id)} alt={image.fileName} className="max-h-28 rounded-md border object-contain" />
              </a>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={locked}
                aria-label={`Remove ${image.fileName}`}
                onClick={() => void remove(image)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={`${id}-images`}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        multiple
        disabled={busy || locked || images.length >= MAX_TASK_IMAGES}
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = "";
        }}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
