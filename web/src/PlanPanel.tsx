import { planHeadline, type Plan, type PlanArtifact, type Task } from "@dot/shared";
import { Check, CornerUpLeft, Pencil } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "./api.ts";
import { Headline, MoreDetails } from "./detail.tsx";
import { Prose } from "./Prose.tsx";

// What the fold holds, so you can tell whether it is worth opening.
function detailLabel(plan: Plan): string {
  const parts = [`${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}`];
  if (plan.filesToTouch.length) parts.push(`${plan.filesToTouch.length} ${plan.filesToTouch.length === 1 ? "file" : "files"}`);
  if (plan.context.trim()) parts.push("context");
  if (plan.testPlan.trim()) parts.push("test plan");
  return parts.join(", ");
}

export function PlanPanel({ task, artifact }: { task: Task; artifact: PlanArtifact | null }) {
  const [editing, setEditing] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notesId = useId();

  const editable = task.column === "research" || task.column === "plan_review";
  const reviewing = task.column === "plan_review";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!artifact) {
    return (
      <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        {task.column === "inbox"
          ? "No plan yet. Start research and the researcher will write one."
          : "The researcher is still working on the plan."}
      </p>
    );
  }

  if (editing) {
    return (
      <PlanEditor
        plan={artifact.plan}
        busy={busy}
        error={error}
        onCancel={() => setEditing(false)}
        onSave={async (plan) => {
          if (await run(() => api.savePlan(task.id, plan))) setEditing(false);
        }}
      />
    );
  }

  const { plan } = artifact;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 flex items-center gap-2">
          <p className="flex-1 text-xs text-muted-foreground">
            Version {artifact.version}, by {artifact.author === "agent" ? "the researcher" : "you"},{" "}
            {new Date(artifact.createdAt).toLocaleString()}
          </p>
          {editable && (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          )}
        </div>

        <div className="grid gap-6">
          <Headline>{planHeadline(plan)}</Headline>
          <Section title="Goal">
            <Prose className="text-sm">{plan.goal}</Prose>
          </Section>
          <Section title="Acceptance criteria">
            <ul className="grid gap-1.5 text-sm">
              {plan.acceptanceCriteria.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  <Prose>{c}</Prose>
                </li>
              ))}
            </ul>
          </Section>
          <BulletSection title="Assumptions" items={plan.assumptions} />
          <BulletSection title="Risks" items={plan.risks} />
          <MoreDetails label={detailLabel(plan)} className="gap-6">
          {plan.context.trim() && (
            <Section title="Context">
              <Prose className="text-sm">{plan.context}</Prose>
            </Section>
          )}
          {plan.filesToTouch.length > 0 && (
            <Section title="Files to touch">
              <ul className="grid gap-2 text-sm">
                {plan.filesToTouch.map((f, i) => (
                  <li key={i}>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{f.path}</code>
                    <Prose className="mt-1 text-muted-foreground">{f.change}</Prose>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Steps">
            <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
              {plan.steps.map((s, i) => (
                <li key={i}>
                  <Prose>{s}</Prose>
                </li>
              ))}
            </ol>
          </Section>
          {plan.testPlan.trim() && (
            <Section title="Test plan">
              <Prose className="text-sm">{plan.testPlan}</Prose>
            </Section>
          )}
          </MoreDetails>
        </div>
      </div>

      {reviewing && (
        <div className="grid gap-3 border-t bg-background p-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {sendingBack ? (
            <form
              className="grid gap-2"
              onSubmit={async (e: FormEvent) => {
                e.preventDefault();
                if (await run(() => api.sendBack(task.id, notes))) {
                  setNotes("");
                  setSendingBack(false);
                }
              }}
            >
              <Label htmlFor={notesId}>What should the researcher change?</Label>
              <Textarea
                id={notesId}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                autoFocus
                required
                className="max-h-48 min-h-20"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setSendingBack(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !notes.trim()}>
                  <CornerUpLeft aria-hidden="true" />
                  Send back
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setSendingBack(true)}>
                <CornerUpLeft aria-hidden="true" />
                Send back
              </Button>
              <Button type="button" disabled={busy} onClick={() => void run(() => api.approvePlan(task.id))}>
                <Check aria-hidden="true" />
                Approve plan
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function BulletSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="grid list-disc gap-1.5 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i}>
            <Prose>{item}</Prose>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// Lists edit as one item per line. Files edit as "path: what changes".
const lines = (value: string) =>
  value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function PlanEditor(props: {
  plan: Plan;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (plan: Plan) => void;
}) {
  const { plan } = props;
  const id = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const get = (name: string) => String(form.get(name) ?? "");
    props.onSave({
      headline: get("headline").trim() || planHeadline(plan),
      goal: get("goal").trim(),
      context: get("context"),
      acceptanceCriteria: lines(get("acceptanceCriteria")),
      filesToTouch: lines(get("filesToTouch")).map((line) => {
        const split = line.indexOf(": ");
        return split === -1
          ? { path: line, change: "Change as described in the steps." }
          : { path: line.slice(0, split).trim(), change: line.slice(split + 2).trim() };
      }),
      steps: lines(get("steps")),
      testPlan: get("testPlan"),
      risks: lines(get("risks")),
      assumptions: lines(get("assumptions")),
    });
  }

  const field = (name: keyof Plan, label: string, value: string, hint?: string, rows = 4) => (
    <div className="grid gap-2">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      {hint && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
      <Textarea id={`${id}-${name}`} name={name} defaultValue={value} rows={rows} className="font-normal" />
    </div>
  );

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4">
        {field("headline", "Headline", planHeadline(plan), "One sentence. It leads the plan.", 2)}
        {field("goal", "Goal", plan.goal, undefined, 2)}
        {field("acceptanceCriteria", "Acceptance criteria", plan.acceptanceCriteria.join("\n"), "One per line.")}
        {field("context", "Context", plan.context, undefined, 6)}
        {field(
          "filesToTouch",
          "Files to touch",
          plan.filesToTouch.map((f) => `${f.path}: ${f.change}`).join("\n"),
          'One per line, as "path: what changes".',
        )}
        {field("steps", "Steps", plan.steps.join("\n"), "One per line, in order.", 6)}
        {field("testPlan", "Test plan", plan.testPlan)}
        {field("assumptions", "Assumptions", plan.assumptions.join("\n"), "One per line.")}
        {field("risks", "Risks", plan.risks.join("\n"), "One per line.")}
      </div>
      <div className="grid gap-2 border-t bg-background p-3">
        {props.error && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-wrap">{props.error}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={props.busy}>
            Save as new version
          </Button>
        </div>
      </div>
    </form>
  );
}
