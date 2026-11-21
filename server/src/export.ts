import { COLUMN_LABELS, planHeadline, reportDocHeadline, reportHeadline } from "@dot/shared";
import type { Store } from "./store.ts";

// A task as one Markdown document: what was asked, the latest plan, report and review, and the history.
// For a pull request description, a ticket, or a record of how the work went.

const bullets = (items: string[]) => items.map((i) => `- ${i.replace(/\n/g, "\n  ")}`).join("\n");
const numbered = (items: string[]) => items.map((i, n) => `${n + 1}. ${i.replace(/\n/g, "\n   ")}`).join("\n");

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

export function taskMarkdown(store: Store, taskId: number): string {
  const task = store.getTask(taskId);
  const project = store.getProject(task.projectId);
  const plan = store.latestPlan(taskId);
  const report = store.latestExecutionReport(taskId);
  const review = store.latestReview(taskId);
  const doc = store.latestReportDoc(taskId);

  const facts = [
    `- Project: ${project.name}`,
    `- Column: ${COLUMN_LABELS[task.column]}`,
    task.branch ? `- Branch: \`${task.branch}\`` : "",
    task.prUrl ? `- Pull request: ${task.prUrl}` : "",
    task.costUsd > 0 ? `- Agent cost: about $${task.costUsd.toFixed(2)} at API prices` : "",
    task.blockedBy.length > 0 ? `- Waiting on: ${task.blockedBy.map((b) => `#${b.number}`).join(", ")}` : "",
  ].filter(Boolean);

  const parts = [`# #${task.number} ${task.title}\n\n${facts.join("\n")}\n`, section("Request", task.description)];

  if (doc) {
    const d = doc.report;
    parts.push(
      section(
        `Report (version ${doc.version})`,
        [
          `**${reportDocHeadline(d)}**`,
          d.summary,
          d.body,
          d.sources.length > 0
            ? `### Sources\n\n${bullets(d.sources.map((s) => [s.url ? `[${s.title}](${s.url})` : s.title, s.note].filter(Boolean).join(": ")))}`
            : "",
          d.openQuestions.length > 0 ? `### Open questions\n\n${bullets(d.openQuestions)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }

  if (plan) {
    const p = plan.plan;
    parts.push(
      section(
        `Plan (version ${plan.version})`,
        [
          `**${planHeadline(p)}**`,
          `Goal: ${p.goal}`,
          `### Acceptance criteria\n\n${bullets(p.acceptanceCriteria)}`,
          `### Steps\n\n${numbered(p.steps)}`,
          p.filesToTouch.length > 0
            ? `### Files to touch\n\n${bullets(p.filesToTouch.map((f) => `\`${f.path}\`: ${f.change}`))}`
            : "",
          p.assumptions.length > 0 ? `### Assumptions\n\n${bullets(p.assumptions)}` : "",
          p.risks.length > 0 ? `### Risks\n\n${bullets(p.risks)}` : "",
          p.testPlan.trim() ? `### Test plan\n\n${p.testPlan.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }

  if (report) {
    const r = report.report;
    parts.push(
      section(
        `Execution report (version ${report.version})`,
        [
          `**${reportHeadline(r)}**`,
          r.summary,
          report.commits.length > 0 ? `### Commits\n\n${bullets(report.commits.map((c) => `\`${c.hash}\` ${c.subject}`))}` : "",
          r.deviations.length > 0 ? `### Deviations from the plan\n\n${bullets(r.deviations)}` : "",
          r.verification.length > 0
            ? `### Verification\n\n${bullets(r.verification.map((v) => `${v.result}: \`${v.command}\`${v.notes ? `. ${v.notes}` : ""}`))}`
            : "",
          r.followUps.length > 0 ? `### Follow-ups\n\n${bullets(r.followUps)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }

  if (review) {
    const v = review.review;
    parts.push(
      section(
        `Review (round ${review.version}, ${v.verdict === "approve" ? "approved" : "changes requested"})`,
        [
          `**${v.headline}**`,
          v.summary,
          `### Acceptance criteria\n\n${bullets(v.criteria.map((c) => `${c.status.replace("_", " ")}: ${c.criterion}. ${c.evidence}`))}`,
          v.issues.length > 0
            ? `### Issues\n\n${bullets(
                v.issues.map(
                  (i) =>
                    `${i.severity === "blocking" ? "Blocking" : "Optional"}: ${i.title}${i.file ? ` (\`${i.file}${i.line ? `:${i.line}` : ""}\`)` : ""}. ${i.details}`,
                ),
              )}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }

  const events = store.listEvents(taskId).map((e) => {
    const day = e.createdAt.replace("T", " ").slice(0, 16);
    const what = e.kind === "moved" ? `moved to ${COLUMN_LABELS[e.detail as keyof typeof COLUMN_LABELS] ?? e.detail}` : e.kind === "needs_you" ? "needed you" : "an agent failed";
    return `${day} UTC, ${what}`;
  });
  parts.push(section("History", bullets(events)));

  return `${parts.filter(Boolean).join("\n")}\n`;
}
