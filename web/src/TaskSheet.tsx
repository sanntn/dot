import {
  AGENT_STAGES,
  COLUMN_LABELS,
  COLUMNS,
  STAGE_LABELS,
  type AgentStage,
  type ChatMessage,
  type Column,
  type PlanArtifact,
  type ReviewArtifact,
  type Run,
  type Task,
} from "@dot/shared";
import { FileText, GitMerge, GitPullRequest, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { AgentBadge } from "./AgentBadge.tsx";
import { api, errorMessage } from "./api.ts";
import { cn } from "@/lib/utils";
import { BlockerPicker } from "./BlockerPicker.tsx";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { serialLoader, subscribe } from "./events.ts";
import { PlanPanel } from "./PlanPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { TaskFields } from "./TaskDialog.tsx";
import { TaskImages } from "./TaskImages.tsx";

type Tab = "chat" | "plan" | "changes" | "review" | "activity" | "details";

// Which agent belongs to a column. Columns without an agent map to nothing.
const COLUMN_STAGE: Partial<Record<Column, AgentStage>> = {
  research: "research",
  plan_review: "research",
  execute: "execute",
  review: "review",
  merge_approval: "review",
};

// Open on what the task is waiting for: the plan in Plan review, the review once there is one.
function initialTab(task: Task): Tab {
  if (task.column === "plan_review") return "plan";
  if (task.column === "merge_approval" || (task.column === "review" && task.needsInput)) return "review";
  if (task.column === "merge") return "chat";
  return "chat";
}

// The task panel. Mounted to open; onClose runs after the close animation.
export function TaskSheet({ task, tasks, onClose }: { task: Task; tasks: Task[]; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>(() => initialTab(task));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [plan, setPlan] = useState<PlanArtifact | null>(null);
  const [review, setReview] = useState<ReviewArtifact | null>(null);
  const [reportVersion, setReportVersion] = useState<number | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Plan and runs are small and change rarely. Messages grow, so fetch only the ones after the last seen id.
  const lastMessageId = useRef(0);

  const loadMeta = useMemo(
    () =>
      serialLoader(async () => {
        try {
          const [p, rv, rp, r] = await Promise.all([
            api.getPlan(task.id),
            api.getReview(task.id),
            api.getReport(task.id),
            api.listRuns(task.id),
          ]);
          setPlan(p);
          setReview(rv);
          setReportVersion(rp?.version ?? null);
          setRuns(r);
        } catch (err) {
          setError(errorMessage(err));
        }
      }),
    [task.id],
  );

  const loadMessages = useMemo(
    () =>
      serialLoader(async () => {
        try {
          const fresh = await api.listMessages(task.id, lastMessageId.current);
          if (fresh.length === 0) return;
          lastMessageId.current = fresh[fresh.length - 1]!.id;
          setMessages((prev) => [...prev, ...fresh]);
        } catch (err) {
          setError(errorMessage(err));
        }
      }),
    [task.id],
  );

  useEffect(() => {
    loadMessages();
    loadMeta();
    return subscribe({
      onOpen: () => {
        loadMessages();
        loadMeta();
      },
      onEvent: (event) => {
        if (event.type === "messages.changed" && event.taskId === task.id) loadMessages();
        // Task state changes (plan submitted, run finished, cost updated) come with tasks.changed.
        // Events for other tasks are skipped. One without a task id could be about any task.
        if (
          event.type === "tasks.changed" &&
          event.projectId === task.projectId &&
          (event.taskId === undefined || event.taskId === task.id)
        ) {
          loadMeta();
        }
      },
    });
  }, [loadMessages, loadMeta, task.id, task.projectId]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Files whose changes the Changes tab can't show in full (cut off, or binary). Approving the merge
  // asks for a second click while any exist, so a padded diff can't slip a change past you.
  const [unseenFiles, setUnseenFiles] = useState<string[] | null>(null);

  async function approveMerge(confirmed = false) {
    if (!confirmed) {
      const diff = await api.getDiff(task.id);
      const unseen = diff?.files.filter((f) => f.truncated || f.binary).map((f) => f.path) ?? [];
      if (unseen.length > 0) {
        setUnseenFiles(unseen);
        return;
      }
    }
    setUnseenFiles(null);
    await api.merge(task.id);
  }

  const working = task.agentState === "running" || task.agentState === "queued";
  const cost = runs.reduce((sum, r) => sum + r.costUsd, 0);

  // One chat per agent that has started. The current column's agent is the default.
  const stagesWithRuns = AGENT_STAGES.filter((s) => runs.some((r) => r.stage === s));
  const columnStage = AGENT_STAGES.find((s) => s === COLUMN_STAGE[task.column]);
  const defaultStage: AgentStage =
    (columnStage && stagesWithRuns.includes(columnStage) ? columnStage : stagesWithRuns.at(-1)) ?? "research";
  const [pickedStage, setPickedStage] = useState<AgentStage | null>(null);
  const chatStage = pickedStage && stagesWithRuns.includes(pickedStage) ? pickedStage : defaultStage;
  const chatStages = stagesWithRuns.length > 0 ? stagesWithRuns : (["research"] as AgentStage[]);

  // A start or resume button for the agent of the current column, whenever it isn't running.
  const researchRun = runs.find((r) => r.stage === "research");
  const executeRun = runs.find((r) => r.stage === "execute");
  const reviewRun = runs.find((r) => r.stage === "review");
  // The latest report is already reviewed when the latest review is for it. Then you decide, not the agent.
  const roundReviewed = review !== null && review.reportVersion === reportVersion;
  const startLabel =
    working || busy
      ? null
      : task.column === "inbox"
        ? "Start research"
        : task.column === "research"
          ? researchRun
            ? "Resume researcher"
            : "Start research"
          : task.column === "execute"
            ? !executeRun
              ? "Start executor"
              : task.agentState === "failed"
                ? "Retry executor"
                : "Resume executor"
            : task.column === "review" && !roundReviewed
              ? reviewRun
                ? "Resume reviewer"
                : "Start reviewer"
              : null;
  const canRetry =
    !busy && stagesWithRuns.length > 0 && task.column !== "inbox" && task.column !== "done" && !(task.column === "merge" && working);
  const showReviewTab =review !== null || task.column === "review" || task.column === "merge_approval";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        onCloseAutoFocus={onClose}
      >
        <SheetHeader className="gap-2 border-b pr-12">
          <SheetTitle className="text-base">{task.title}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">#{task.number}</span>
              <Badge variant="outline">{COLUMN_LABELS[task.column]}</Badge>
              <AgentBadge task={task} />
              {cost > 0 && (
                <span className="text-xs" title="What this usage would cost at API prices. Your subscription covers it.">
                  {cost < 0.01 ? "< $0.01" : `≈ $${cost.toFixed(2)}`} at API prices
                </span>
              )}
              {task.prUrl && (
                <a
                  href={task.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                >
                  <GitPullRequest className="size-3" aria-hidden="true" />
                  Pull request #{task.prId}
                </a>
              )}
            </div>
          </SheetDescription>
          <div className="flex flex-wrap gap-2 pt-1">
            {startLabel && (
              <Button size="sm" onClick={() => void act(() => api.startTask(task.id))}>
                <Play aria-hidden="true" />
                {startLabel}
              </Button>
            )}
            {task.column === "merge_approval" && !working && (
              <Button size="sm" disabled={busy} onClick={() => void act(() => approveMerge())}>
                <GitMerge aria-hidden="true" />
                Merge
              </Button>
            )}
            {task.column === "merge" && !working && (
              <>
                <Button size="sm" disabled={busy} onClick={() => void act(() => api.merge(task.id))}>
                  <GitMerge aria-hidden="true" />
                  Retry merge
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.merge(task.id, true))}>
                  Merge without CI
                </Button>
              </>
            )}
            {task.column === "plan_review" && tab !== "plan" && (
              <Button size="sm" onClick={() => setTab("plan")}>
                <FileText aria-hidden="true" />
                Review plan
              </Button>
            )}
            {canRetry && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <RotateCcw aria-hidden="true" />
                    Retry from
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="grid w-72 gap-2">
                  <p className="text-xs text-muted-foreground">
                    Starts that agent again with a new session. Plans, reports and reviews stay, and so do the branch and its commits.
                  </p>
                  {stagesWithRuns.map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => api.retryStage(task.id, s))}
                    >
                      {STAGE_LABELS[s]}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            )}
            {working && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.stopTask(task.id))}>
                <Square aria-hidden="true" />
                {task.column === "merge" ? "Stop merge" : "Stop agent"}
              </Button>
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
            </Alert>
          )}
          {unseenFiles && task.column === "merge_approval" && (
            <Alert>
              <AlertDescription className="grid gap-2">
                <span>
                  {unseenFiles.length === 1 ? "One file's changes" : `${unseenFiles.length} files' changes`} can't be shown in
                  full in the Changes tab. Check {unseenFiles.length === 1 ? "it" : "them"} in your editor before merging:
                </span>
                <ul className="list-disc pl-5 font-mono text-xs [overflow-wrap:anywhere]">
                  {unseenFiles.slice(0, 10).map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                  {unseenFiles.length > 10 && <li>and {unseenFiles.length - 10} more</li>}
                </ul>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void act(() => approveMerge(true))}>
                    Merge anyway
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setUnseenFiles(null)}>
                    Cancel
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </SheetHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-4 mt-3">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="plan">Plan{plan ? ` v${plan.version}` : ""}</TabsTrigger>
            {task.branch && <TabsTrigger value="changes">Changes</TabsTrigger>}
            {showReviewTab && <TabsTrigger value="review">Review{review ? ` ${review.version}` : ""}</TabsTrigger>}
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>
          {/* forceMount keeps each tab alive while hidden, so a half-written message or plan edit survives a tab switch. */}
          <TabsContent value="chat" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            {chatStages.length > 1 && (
              <div role="group" aria-label="Agent" className="mx-4 mt-3 flex gap-1">
                {chatStages.map((s) => (
                  <Button
                    key={s}
                    size="xs"
                    variant={s === chatStage ? "secondary" : "ghost"}
                    aria-pressed={s === chatStage}
                    onClick={() => setPickedStage(s)}
                  >
                    {STAGE_LABELS[s]}
                  </Button>
                ))}
              </div>
            )}
            {/* One panel per agent, so each keeps its own unsent draft. */}
            {chatStages.map((s) => (
              <div key={s} className={cn("flex min-h-0 flex-1 flex-col", s !== chatStage && "hidden")}>
                <ChatPanel
                  task={task}
                  stage={s}
                  messages={messages.filter((m) => m.stage === s || m.stage === null)}
                  hasRun={runs.some((r) => r.stage === s)}
                  onView={setTab}
                />
              </div>
            ))}
          </TabsContent>
          <TabsContent value="review" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            {showReviewTab && <ReviewPanel task={task} artifact={review} working={working} />}
          </TabsContent>
          <TabsContent value="changes" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            {task.branch && (
              <ChangesPanel task={task} active={tab === "changes"} version={messages.length + runs.length} />
            )}
          </TabsContent>
          <TabsContent value="plan" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            <PlanPanel task={task} artifact={plan} />
          </TabsContent>
          <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
            <ActivityPanel taskId={task.id} runs={runs} messages={messages} />
          </TabsContent>
          <TabsContent value="details" forceMount className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
            <TaskDetails task={task} tasks={tasks} onDeleted={() => setOpen(false)} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function DependencyList({ title, tasks }: { title: string; tasks: { id: number; number: number; title: string; column: Column | null }[] }) {
  return (
    <div className="grid gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="grid gap-1">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <span className="tabular-nums text-muted-foreground">#{t.number}</span>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {t.column && <Badge variant="outline">{COLUMN_LABELS[t.column]}</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskDetails({ task, tasks, onDeleted }: { task: Task; tasks: Task[]; onDeleted: () => void }) {
  const id = useId();
  const [blockers, setBlockers] = useState<number[]>(() => task.blockedBy.map((b) => b.id));
  const [autoStart, setAutoStart] = useState(task.autoStart);
  // Tasks still waiting on this one.
  const blocking = tasks.filter((t) => t.blockedBy.some((b) => b.id === task.id));
  const candidates = tasks.filter((t) => t.id !== task.id && (t.column !== "done" || blockers.includes(t.id)));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
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

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const column = String(form.get("column") ?? "") as Column;
    void run(async () => {
      await api.updateTask(task.id, {
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        blockedBy: blockers,
        autoStart: autoStart && blockers.length > 0,
      });
      if (column && column !== task.column) await api.moveTask(task.id, { column, beforeTaskId: null });
    }).then((ok) => setSaved(ok));
  }

  return (
    <form className="grid gap-5 p-4" onSubmit={onSubmit}>
      <TaskFields id={id} title={task.title} description={task.description} />
      <BlockerPicker candidates={candidates} value={blockers} onChange={setBlockers} autoStart={autoStart} onAutoStart={setAutoStart} />
      {(task.blockedBy.length > 0 || blocking.length > 0) && (
        <div className="grid gap-3 rounded-md border p-3 text-sm">
          {task.blockedBy.length > 0 && (
            <DependencyList
              title="Waiting on"
              tasks={task.blockedBy.map((b) => tasks.find((t) => t.id === b.id) ?? { id: b.id, number: b.number, title: "", column: null })}
            />
          )}
          {blocking.length > 0 && <DependencyList title="Blocking" tasks={blocking} />}
        </div>
      )}
      <TaskImages taskId={task.id} locked={busy} />
      <div className="grid gap-2">
        <Label htmlFor={`${id}-column`}>Column</Label>
        <p className="-mt-1 text-xs text-muted-foreground">
          Moving a card by hand does not start or stop agents. Use the buttons at the top for that.
        </p>
        <Select name="column" defaultValue={task.column} key={task.column}>
          <SelectTrigger id={`${id}-column`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLUMNS.map((c) => (
              <SelectItem key={c} value={c}>
                {COLUMN_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <ConfirmButton
          label="Delete task"
          title="Delete this task?"
          description={`"${task.title}" will be removed from the board, with its chat and plan. Any running agent stops. This cannot be undone.`}
          confirmLabel="Delete task"
          disabled={busy}
          onConfirm={() => void run(() => api.deleteTask(task.id)).then((ok) => ok && onDeleted())}
        />
        <span className="flex-1 text-right text-sm text-muted-foreground" role="status">
          {saved ? "Saved." : ""}
        </span>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
