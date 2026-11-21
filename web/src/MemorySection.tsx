import { MAX_MEMORY_NOTES, type ProjectMemory } from "@dot/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "./api.ts";

// In Preferences: the notes the project's agents saved for later tasks. Agents write them without asking,
// so this is where you read them, fix them and remove the wrong ones.
export function MemorySection({ projectId }: { projectId: number }) {
  const [notes, setNotes] = useState<ProjectMemory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const active = notes.filter((n) => n.status === "active");
  const suggested = notes.filter((n) => n.status === "suggested");

  useEffect(() => {
    let alive = true;
    api.listMemory(projectId).then(
      (found) => alive && setNotes(found),
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function act(work: () => Promise<void>) {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function onAdd(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    void act(async () => {
      const saved = await api.addMemory(projectId, value);
      setNotes((prev) => [...prev, saved]);
      setText("");
    });
  }

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (!editing || !editing.text.trim()) return;
    const { id } = editing;
    void act(async () => {
      const saved = await api.updateMemory(id, { text: editing.text.trim() });
      setNotes((prev) => prev.map((n) => (n.id === id ? saved : n)));
      setEditing(null);
    });
  }

  return (
    <section className="grid gap-2" aria-labelledby="memory-heading">
      <h3 id="memory-heading" className="text-sm font-semibold">
        Project memory
      </h3>
      <p className="text-sm text-muted-foreground">
        Agents suggest short facts here as they work, such as the real test command or where something lives. A note
        reaches agents only after you accept it, and every agent reads accepted notes first. Check what a note tells
        agents to do before you accept it. {notes.length} of {MAX_MEMORY_NOTES} used.
      </p>
      {notes.length === 0 && <p className="text-sm text-muted-foreground">Nothing saved yet.</p>}
      {suggested.length > 0 && (
        <ul className="grid gap-2" aria-label="Suggested notes">
          {suggested.map((note) => (
            <li key={note.id} className="grid gap-2 rounded-lg border border-dashed p-2 text-sm">
              <span className="break-words">{note.text}</span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void act(async () => {
                      const saved = await api.updateMemory(note.id, { status: "active" });
                      setNotes((prev) => prev.map((n) => (n.id === note.id ? saved : n)));
                    })
                  }
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act(async () => {
                      await api.deleteMemory(note.id);
                      setNotes((prev) => prev.filter((n) => n.id !== note.id));
                    })
                  }
                >
                  Dismiss
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid gap-2">
        {active.map((note) =>
          editing?.id === note.id ? (
            <li key={note.id}>
              <form onSubmit={onSave} className="flex gap-2">
                <Input
                  aria-label="Edit note"
                  value={editing.text}
                  maxLength={300}
                  onChange={(e) => setEditing({ id: note.id, text: e.target.value })}
                  autoFocus
                />
                <Button type="submit" size="sm">
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            </li>
          ) : (
            <li key={note.id} className="flex items-start gap-2 rounded-lg border p-2 text-sm">
              <span className="min-w-0 flex-1 break-words">{note.text}</span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Edit note"
                onClick={() => setEditing({ id: note.id, text: note.text })}
              >
                <Pencil aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Delete note"
                onClick={() =>
                  void act(async () => {
                    await api.deleteMemory(note.id);
                    setNotes((prev) => prev.filter((n) => n.id !== note.id));
                  })
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ),
        )}
      </ul>
      <form onSubmit={onAdd} className="flex gap-2">
        <Input
          aria-label="New note"
          placeholder="Add a note yourself"
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
          <Plus aria-hidden="true" />
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
