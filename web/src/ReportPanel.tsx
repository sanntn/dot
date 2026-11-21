import { reportDocHeadline, type ReportDocArtifact, type Task } from "@dot/shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "./api.ts";
import { Headline } from "./detail.tsx";
import { Prose } from "./Prose.tsx";
import { ReviewBar } from "./ReviewBar.tsx";

// Only web addresses become links. A source may also be a repository path, which has nowhere to go.
function isWebUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// A report task's output: the document, its sources, and what the agent could not settle.
export function ReportPanel({ task, artifact }: { task: Task; artifact: ReportDocArtifact | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewing = task.column === "report_review";

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
        {task.column === "inbox" ? "No report yet. Start research and the agent will write one." : "The agent is still working on the report."}
      </p>
    );
  }

  const { report } = artifact;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="mb-4 text-xs text-muted-foreground">
          Version {artifact.version}, by {artifact.author === "agent" ? "the agent" : "you"}, {new Date(artifact.createdAt).toLocaleString()}
        </p>
        <div className="grid gap-6">
          <div className="grid gap-2">
            <Headline>{reportDocHeadline(report)}</Headline>
            <p className="text-sm text-muted-foreground">{report.summary}</p>
          </div>
          <Prose className="text-sm">{report.body}</Prose>
          {report.sources.length > 0 && (
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Sources</h3>
              <ul className="grid gap-1.5 text-sm">
                {report.sources.map((s, i) => (
                  <li key={`${s.title}-${i}`} className="[overflow-wrap:anywhere]">
                    {s.url && isWebUrl(s.url) ? (
                      <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                        {s.title}
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    ) : (
                      <span>
                        {s.title}
                        {s.url ? <span className="ml-1 font-mono text-xs text-muted-foreground">{s.url}</span> : null}
                      </span>
                    )}
                    {s.note ? <span className="text-muted-foreground">: {s.note}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {report.openQuestions.length > 0 && (
            <section className="grid gap-2">
              <h3 className="text-sm font-medium">Open questions</h3>
              <ul className="list-disc pl-5 text-sm">
                {report.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {reviewing && (
        <ReviewBar
          agent="agent"
          approveLabel="Approve report"
          busy={busy}
          error={error}
          onApprove={() => void run(() => api.approveReportDoc(task.id))}
          onSendBack={(notes) => run(() => api.sendBackReportDoc(task.id, notes))}
        />
      )}
    </div>
  );
}
