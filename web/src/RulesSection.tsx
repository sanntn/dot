import type { ProjectRule, Task } from "@dot/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "./api.ts";

// The project's rules and the reviewer's suggestions. One load, shared by both views below.
function useRules(projectId: number) {
  const [rules, setRules] = useState<ProjectRule[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listRules(projectId).then(
      (found) => alive && setRules(found),
      (err) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  const act = useCallback(async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const accept = (rule: ProjectRule) =>
    act(async () => {
      const saved = await api.updateRule(rule.id, { status: "active" });
      setRules((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
    });
  const remove = (rule: ProjectRule) =>
    act(async () => {
      await api.deleteRule(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    });
  const add = (text: string) =>
    act(async () => {
      const saved = await api.addRule(projectId, text);
      setRules((prev) => [...prev, saved]);
    });

  return { rules, error, accept, remove, add };
}

function SuggestionRow({ rule, onAccept, onDismiss }: { rule: ProjectRule; onAccept: () => void; onDismiss: () => void }) {
  return (
    <li className="grid gap-2 rounded-lg border border-dashed p-2 text-sm">
      <span>{rule.text}</span>
      <span className="flex gap-2">
        <Button size="sm" onClick={onAccept}>
          Add as a rule
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </span>
    </li>
  );
}

// In a task's Review tab: what this review suggests the project's agents should always do.
export function RuleSuggestions({ task }: { task: Task }) {
  const { rules, error, accept, remove } = useRules(task.projectId);
  const mine = rules.filter((r) => r.status === "suggested" && r.sourceTaskId === task.id);
  if (mine.length === 0 && !error) return null;
  return (
    <section className="grid gap-2" aria-labelledby={`rules-${task.id}`}>
      <h3 id={`rules-${task.id}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Suggested rules
      </h3>
      <p className="text-xs text-muted-foreground">
        The reviewer thinks every task in this project should follow these. Agents see a rule only after you add it.
      </p>
      <ul className="grid gap-2">
        {mine.map((rule) => (
          <SuggestionRow key={rule.id} rule={rule} onAccept={() => void accept(rule)} onDismiss={() => void remove(rule)} />
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

// In Preferences: every rule in the project, with a form to write your own.
export function RulesSection({ projectId }: { projectId: number }) {
  const { rules, error, accept, remove, add } = useRules(projectId);
  const [text, setText] = useState("");
  const active = rules.filter((r) => r.status === "active");
  const suggested = rules.filter((r) => r.status === "suggested");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    void add(value);
  }

  return (
    <section className="grid gap-2" aria-labelledby="rules-heading">
      <h3 id="rules-heading" className="text-sm font-semibold">
        Project rules
      </h3>
      <p className="text-sm text-muted-foreground">
        Every agent in this project reads these at the start. The reviewer also suggests rules when it keeps seeing the
        same mistake.
      </p>
      {suggested.length > 0 && (
        <ul className="grid gap-2" aria-label="Suggested rules">
          {suggested.map((rule) => (
            <SuggestionRow key={rule.id} rule={rule} onAccept={() => void accept(rule)} onDismiss={() => void remove(rule)} />
          ))}
        </ul>
      )}
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rules yet.</p>
      ) : (
        <ul className="grid gap-1">
          {active.map((rule) => (
            <li key={rule.id} className="flex items-start justify-between gap-2 text-sm">
              <span className="min-w-0 [overflow-wrap:anywhere]">{rule.text}</span>
              <Button variant="ghost" size="xs" aria-label={`Remove rule: ${rule.text}`} onClick={() => void remove(rule)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={onSubmit}>
        <Input
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          aria-label="New rule"
          placeholder="Use the shared api client, not fetch."
        />
        <Button type="submit" variant="outline" disabled={!text.trim()}>
          <Plus aria-hidden="true" />
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
