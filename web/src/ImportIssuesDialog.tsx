import { MAX_BATCH_IMPORT, type ExternalIssue, type Project } from "@dot/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "./api.ts";

// Open GitHub issues of the project's repository, or cards on its Favro board, to turn into tasks. An item that
// already has a task is marked. The pull request for an imported issue says "Closes #n", so GitHub closes it on merge.
type Source = "github" | "favro";
export function ImportIssuesDialog(props: { project: Project; onClose: () => void; onOpenTask: (taskId: number) => void }) {
  const id = useId();
  const projectId = props.project.id;
  const sources: Source[] = [...(props.project.kind === "repo" ? (["github"] as const) : []), ...(props.project.favroBoard ? (["favro"] as const) : [])];
  const [source, setSource] = useState<Source>(sources[0] ?? "github");
  const favro = source === "favro";
  const [label, setLabel] = useState("");
  const [appliedLabel, setAppliedLabel] = useState("");
  const [issues, setIssues] = useState<ExternalIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);

  // The open items of the chosen source, and whether the source had more than Dot reads.
  const load = () =>
    favro
      ? api.listFavroCards(projectId, appliedLabel || undefined)
      : api.listIssues(projectId, appliedLabel || undefined).then((found) => ({ cards: found, truncated: false }));
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let alive = true;
    setIssues(null);
    setError(null);
    load().then(
      (found) => {
        if (!alive) return;
        setIssues(found.cards);
        setTruncated(found.truncated);
        setPicked([]);
      },
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [projectId, appliedLabel, favro]);

  function chooseSource(next: Source) {
    setSource(next);
    setLabel("");
    setAppliedLabel("");
    setPicked([]);
  }

  const toggle = (number: number) => setPicked((prev) => (prev.includes(number) ? prev.filter((n) => n !== number) : [...prev, number]));

  async function onImport() {
    setBusy(true);
    setError(null);
    try {
      const { skipped } = await (favro ? api.importFavroCards : api.importIssues)(projectId, picked, start);
      if (skipped.length === 0) {
        props.onClose();
        return;
      }
      // Say what did not import, and keep the dialog open so it is not missed.
      setError(`Not imported: ${skipped.map((s) => `#${s.number} (${s.reason})`).join(", ")}.`);
      setBusy(false);
      const found = await load();
      setIssues(found.cards);
      setTruncated(found.truncated);
      setPicked([]);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function onFilter(e: FormEvent) {
    e.preventDefault();
    setAppliedLabel(label.trim());
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{favro ? "Import Favro cards" : "Import GitHub issues"}</DialogTitle>
          <DialogDescription>
            Each pick becomes a task in the Inbox. Dot reads the text again from {favro ? "Favro" : "GitHub"}.
          </DialogDescription>
        </DialogHeader>

        {sources.length > 1 && (
          <div className="flex gap-2" role="group" aria-label="Source">
            <Button type="button" size="sm" variant={favro ? "outline" : "default"} onClick={() => chooseSource("github")}>
              GitHub issues
            </Button>
            <Button type="button" size="sm" variant={favro ? "default" : "outline"} onClick={() => chooseSource("favro")}>
              Favro cards
            </Button>
          </div>
        )}

        <form onSubmit={onFilter} className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor={`${id}-label`}>{favro ? "Only cards in this column" : "Only issues with this label"}</Label>
            <Input id={`${id}-label`} value={label} placeholder={favro ? "A column name, or leave empty for every card" : "Leave empty for every open issue"} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <Button type="submit" variant="outline">
            Filter
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!issues && !error && <p className="text-sm text-muted-foreground">Loading</p>}
        {truncated && (
          <p className="text-sm text-muted-foreground">Dot reads the first 500 cards only. Filter by column to see the rest.</p>
        )}
        {issues && issues.length === 0 && <p className="text-sm text-muted-foreground">No open issues found.</p>}

        <ul className="grid max-h-80 gap-1 overflow-y-auto">
          {issues?.map((issue) => {
            const imported = issue.taskId != null;
            return (
              <li key={issue.number} className="flex items-start gap-3 rounded-lg border p-2 text-sm">
                <Checkbox
                  id={`${id}-${issue.number}`}
                  className="mt-0.5"
                  checked={picked.includes(issue.number)}
                  disabled={imported || (!picked.includes(issue.number) && picked.length >= MAX_BATCH_IMPORT)}
                  onCheckedChange={() => toggle(issue.number)}
                />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <label htmlFor={`${id}-${issue.number}`} className="break-words">
                    <span className="tabular-nums text-muted-foreground">#{issue.number}</span> {issue.title}
                  </label>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {issue.labels.join(", ")}
                    {issue.url && (
                      <a href={issue.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        Open on GitHub
                      </a>
                    )}
                    {imported && (
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => {
                          props.onClose();
                          props.onOpenTask(issue.taskId!);
                        }}
                      >
                        Already a task
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Checkbox id={`${id}-start`} checked={start} onCheckedChange={(v) => setStart(v === true)} />
            <Label htmlFor={`${id}-start`}>Start research right away</Label>
          </div>
          <Button disabled={picked.length === 0} loading={busy} onClick={() => void onImport()}>
            {picked.length === 0 ? "Import" : `Import ${picked.length} ${picked.length === 1 ? "issue" : "issues"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
