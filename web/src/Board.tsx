import { COLUMNS, type Column, type Task, type TaskMove } from "@dot/shared";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Check, ExternalLink, GripVertical, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { AgentBadge } from "./AgentBadge.tsx";
import { laneEntry, LANE_LABELS, LANES, canRetry, canStart, isActive, laneOf, statusLine, stepOf, type Lane } from "./lanes.ts";
import { byPosition } from "./move.ts";

// Needs you is the only lane that waits on a person, so it gets the warm dot and tint.
const LANE_DOT: Record<Lane, string> = {
  inbox: "bg-muted-foreground/50",
  working: "bg-sky-500",
  needs_you: "bg-amber-500",
  done: "bg-emerald-500",
};

type DropTarget = TaskMove & { lane: Lane };

type DragState = {
  task: Task;
  pointerId: number;
  card: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  scrollStart: number;
  drop: DropTarget | null;
  frame: number;
  lastTime: number | null;
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sameMove = (a: DropTarget | null, b: DropTarget | null) =>
  a?.lane === b?.lane && a?.column === b?.column && a?.beforeTaskId === b?.beforeTaskId;

export function Board(props: {
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onMove: (task: Task, move: TaskMove) => void;
  onStart: (task: Task) => void;
  onStop: (task: Task) => void;
  onDelete: (task: Task) => void;
  announce: (message: string) => void;
}) {
  const { tasks, onMove, announce } = props;
  const boardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  // Where the dragged card started. It is pinned there with position: fixed so the column's overflow can't clip it.
  const [dragRect, setDragRect] = useState<DOMRect | null>(null);
  const hintId = useId();
  // On a phone one lane fills the screen. Until you pick one, it is the lane that waits for you.
  const [picked, setPicked] = useState<Lane | null>(null);

  // After a move, animate the card from where it was (FLIP) and, for keyboard moves, keep focus on its handle.
  const pendingMove = useRef<{ id: number; from: DOMRect; keyboard: boolean } | null>(null);

  const columns = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c, [] as Task[]])) as Record<Column, Task[]>;
    for (const task of tasks) map[task.column].push(task);
    for (const list of Object.values(map)) list.sort(byPosition);
    return map;
  }, [tasks]);

  // Cards in a lane keep pipeline order, then board position.
  const lanes = useMemo(() => {
    const map = Object.fromEntries(LANES.map((l) => [l, [] as Task[]])) as Record<Lane, Task[]>;
    for (const task of tasks) map[laneOf(task)].push(task);
    for (const list of Object.values(map)) {
      list.sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || byPosition(a, b));
    }
    return map;
  }, [tasks]);

  const shownLane: Lane = picked ?? (lanes.needs_you.length > 0 ? "needs_you" : lanes.working.length > 0 ? "working" : "inbox");

  useLayoutEffect(() => {
    const pending = pendingMove.current;
    if (!pending) return;
    const card = boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${pending.id}"]`);
    if (!card) return;
    pendingMove.current = null;

    card.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (pending.keyboard) card.querySelector<HTMLElement>(".card-handle")?.focus({ preventScroll: true });

    const to = card.getBoundingClientRect();
    const dx = pending.from.left - to.left;
    const dy = pending.from.top - to.top;
    if ((dx || dy) && !reducedMotion()) {
      card.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
        duration: 200,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }

    const task = tasks.find((t) => t.id === pending.id);
    if (task) {
      const lane = laneOf(task);
      const list = lanes[lane];
      const position = list.findIndex((t) => t.id === task.id) + 1;
      announce(`Moved ${task.title} to ${LANE_LABELS[lane]}, position ${position} of ${list.length}.`);
    }
  }, [tasks, lanes, announce]);

  function commitMove(task: Task, move: TaskMove, card: HTMLElement, keyboard: boolean) {
    pendingMove.current = { id: task.id, from: card.getBoundingClientRect(), keyboard };
    onMove(task, move);
  }

  // The task that currently follows `task` in its column, so dropping right back into its own slot is a no-op.
  function nextSiblingId(task: Task): number | null {
    const list = columns[task.column];
    return list[list.findIndex((t) => t.id === task.id) + 1]?.id ?? null;
  }

  function findDrop(x: number, y: number, task: Task): DropTarget | null {
    // The dragged card has pointer-events: none, so this hits whatever is under it.
    const laneEl = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-lane]");
    if (!laneEl) return null;
    const lane = laneEl.dataset.lane as Lane;
    // Inside its own lane a card keeps its column. In another lane it enters at that lane's first column.
    const column = lane === laneOf(task) ? task.column : laneEntry(task, lane);

    let beforeTaskId: number | null = null;
    for (const card of laneEl.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const id = Number(card.dataset.taskId);
      if (id === task.id) continue;
      const rect = card.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        // A card in another column can't anchor the drop, so the task goes to the end of its column.
        if (card.dataset.column === column) beforeTaskId = id;
        break;
      }
    }

    if (column === task.column && beforeTaskId === nextSiblingId(task)) return null;
    return { lane, column, beforeTaskId };
  }

  function update() {
    const d = drag.current;
    const board = boardRef.current;
    if (!d || !board) return;
    const dx = d.lastX - d.startX + (board.scrollLeft - d.scrollStart);
    d.card.style.translate = `${dx}px ${d.lastY - d.startY}px`;

    const next = findDrop(d.lastX, d.lastY, d.task);
    if (!sameMove(next, d.drop)) {
      d.drop = next;
      setDrop(next);
    }
  }

  // Scroll the board sideways while the pointer sits near its left or right edge.
  function autoScroll(time: number) {
    const d = drag.current;
    const board = boardRef.current;
    if (!d || !board) return;
    const rect = board.getBoundingClientRect();
    const zone = Math.min(d.card.offsetWidth, rect.width / 3);
    let speed = 0;
    if (d.lastX < rect.left + zone) speed = -(rect.left + zone - d.lastX) / zone;
    else if (d.lastX > rect.right - zone) speed = (d.lastX - (rect.right - zone)) / zone;
    speed = Math.max(-2, Math.min(2, speed));

    const elapsed = d.lastTime === null ? 16 : time - d.lastTime;
    d.lastTime = time;
    if (speed !== 0) {
      const before = board.scrollLeft;
      board.scrollLeft += speed * elapsed * 0.8;
      if (board.scrollLeft !== before) update();
    }
    d.frame = requestAnimationFrame(autoScroll);
  }

  function endDrag(commit: boolean) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    document.documentElement.classList.remove("is-dragging");
    setDraggingId(null);
    setDrop(null);

    if (commit && d.drop) {
      // Measure with the drag offset still applied, so the card animates from where it was released.
      commitMove(d.task, { column: d.drop.column, beforeTaskId: d.drop.beforeTaskId }, d.card, false);
      d.card.style.translate = "";
    } else {
      d.card.style.translate = "";
      if (!commit) announce(`Move of ${d.task.title} cancelled.`);
    }
  }

  useEffect(() => {
    if (draggingId === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endDrag(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onPointerDown(e: PointerEvent<HTMLButtonElement>, task: Task) {
    if (e.button !== 0 || drag.current || !boardRef.current) return;
    const card = e.currentTarget.closest<HTMLElement>("[data-task-id]");
    if (!card) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      task,
      pointerId: e.pointerId,
      card,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      scrollStart: boardRef.current.scrollLeft,
      drop: null,
      frame: requestAnimationFrame(autoScroll),
      lastTime: null,
    };
    document.documentElement.classList.add("is-dragging");
    setDragRect(card.getBoundingClientRect());
    setDraggingId(task.id);
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    update();
  }

  function onPointerEnd(e: PointerEvent<HTMLButtonElement>, commit: boolean) {
    if (drag.current?.pointerId === e.pointerId) endDrag(commit);
  }

  // Alt + arrows: left/right moves between columns, up/down reorders within one.
  function onHandleKeyDown(e: KeyboardEvent<HTMLButtonElement>, task: Task) {
    if (!e.altKey) return;
    const laneIndex = LANES.indexOf(laneOf(task));
    const list = columns[task.column];
    const index = list.findIndex((t) => t.id === task.id);
    let move: TaskMove | null = null;

    switch (e.key) {
      case "ArrowLeft": {
        const lane = LANES[laneIndex - 1];
        if (lane) move = { column: laneEntry(task, lane), beforeTaskId: null };
        break;
      }
      case "ArrowRight": {
        const lane = LANES[laneIndex + 1];
        if (lane) move = { column: laneEntry(task, lane), beforeTaskId: null };
        break;
      }
      case "ArrowUp": {
        const previous = list[index - 1];
        if (previous) move = { column: task.column, beforeTaskId: previous.id };
        break;
      }
      case "ArrowDown":
        if (index < list.length - 1) move = { column: task.column, beforeTaskId: list[index + 2]?.id ?? null };
        break;
      default:
        return;
    }
    e.preventDefault();
    const card = e.currentTarget.closest<HTMLElement>("[data-task-id]");
    if (move && card) commitMove(task, move, card, true);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
    <nav aria-label="Lanes" className="grid grid-cols-4 gap-1 border-b px-2 py-2 sm:hidden">
      {LANES.map((lane) => (
        <button
          key={lane}
          type="button"
          aria-pressed={shownLane === lane}
          onClick={() => setPicked(lane)}
          className={cn(
            "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-xs text-muted-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            shownLane === lane && "bg-muted font-medium text-foreground",
            lane === "needs_you" && lanes[lane].length > 0 && "text-amber-700 dark:text-amber-300",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2 rounded-full", LANE_DOT[lane])} />
            {LANE_LABELS[lane]}
          </span>
          <span className="tabular-nums">{lanes[lane].length}</span>
        </button>
      ))}
    </nav>
    <div
      ref={boardRef}
      className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-4 overflow-x-auto p-3 sm:auto-cols-[minmax(16rem,1fr)] sm:grid-flow-col sm:grid-cols-none sm:p-4"
    >
      <p id={hintId} hidden>
        Drag to move. Or press Alt with the arrow keys. Left and right change lane, up and down change order.
      </p>
      {LANES.map((lane) => {
        const list = lanes[lane];
        const headingId = `${hintId}-${lane}`;
        const markerBefore = drop?.lane === lane ? drop.beforeTaskId : undefined;
        const waiting = lane === "needs_you";
        return (
          <section
            key={lane}
            data-lane={lane}
            aria-labelledby={headingId}
            className={cn(
              "min-h-0 grid-rows-[auto_1fr] rounded-2xl border bg-muted/40 ring-1 ring-transparent transition-shadow sm:grid",
              shownLane === lane ? "grid" : "hidden",
              waiting && "border-amber-500/30 bg-amber-500/5",
              drop?.lane === lane && "ring-2 ring-primary/50",
            )}
          >
            <header className="flex items-center justify-between px-3 pt-3 pb-2">
              <h2 id={headingId} className="flex items-center gap-2 text-sm font-medium">
                <span aria-hidden="true" className={cn("size-2 rounded-full", LANE_DOT[lane])} />
                {LANE_LABELS[lane]}
              </h2>
              <Badge
                variant="secondary"
                className={cn("tabular-nums", waiting && list.length > 0 && "bg-amber-500/15 text-amber-700 dark:text-amber-300")}
                aria-label={`${list.length} tasks`}
              >
                {list.length}
              </Badge>
            </header>
            <ol className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-3">
              {list.length === 0 && markerBefore === undefined && (
                <li className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  {lane === "needs_you" ? "Nothing waits for you" : lane === "inbox" ? "No tasks waiting" : "Nothing here yet"}
                </li>
              )}
              {list.map((task) => (
                <TaskCardSlot
                  key={task.id}
                  task={task}
                  showMarker={markerBefore === task.id}
                  dragging={draggingId === task.id}
                  dragRect={draggingId === task.id ? dragRect : null}
                  hintId={hintId}
                  onOpen={() => props.onOpenTask(task)}
                  onStart={() => props.onStart(task)}
                  onStop={() => props.onStop(task)}
                  onDelete={() => props.onDelete(task)}
                  onMoveToLane={(target) => {
                    // On a phone only one lane shows. Follow the card there, or it would seem to vanish.
                    setPicked(target);
                    onMove(task, { column: laneEntry(task, target), beforeTaskId: null });
                  }}
                  onPointerDown={(e) => onPointerDown(e, task)}
                  onPointerMove={onPointerMove}
                  onPointerUp={(e) => onPointerEnd(e, true)}
                  onPointerCancel={(e) => onPointerEnd(e, false)}
                  onKeyDown={(e) => onHandleKeyDown(e, task)}
                />
              ))}
              {markerBefore === null && <DropMarker />}
            </ol>
          </section>
        );
      })}
    </div>
    </div>
  );
}

function actionLabel(task: Task): string | null {
  if (task.needsInput) return "Answer";
  if (task.column === "plan_review") return "Review plan";
  if (task.column === "merge_approval") return "Review";
  return null;
}

function TaskCardSlot(props: {
  task: Task;
  showMarker: boolean;
  dragging: boolean;
  dragRect: DOMRect | null;
  hintId: string;
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
  onMoveToLane: (lane: Lane) => void;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { task } = props;
  const done = task.column === "done";
  const step = done || task.column === "inbox" ? null : stepOf(task);
  const retry = canRetry(task);
  const action = retry ? "Retry" : actionLabel(task);
  const status = statusLine(task);
  return (
    <>
      {props.showMarker && <DropMarker />}
      {props.dragRect && <li aria-hidden="true" style={{ height: props.dragRect.height }} />}
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <li
        data-task-id={task.id}
        data-column={task.column}
        data-dragging={props.dragging || undefined}
        style={
          props.dragRect
            ? {
                position: "fixed",
                left: props.dragRect.left,
                top: props.dragRect.top,
                width: props.dragRect.width,
                height: props.dragRect.height,
              }
            : undefined
        }
        className={cn(
          "relative grid scroll-m-3 grid-cols-[auto_minmax(0,1fr)] rounded-xl border bg-card text-card-foreground shadow-xs",
          done && "bg-card/60 shadow-none",
          "has-[.card-handle:focus-visible]:ring-3 has-[.card-handle:focus-visible]:ring-ring/50",
          "data-dragging:pointer-events-none data-dragging:z-10 data-dragging:scale-[1.02] data-dragging:shadow-xl",
        )}
      >
        <button
          type="button"
          className={cn(
            "card-handle grid w-6 cursor-grab touch-none place-items-center rounded-l-xl text-muted-foreground/60 select-none",
            "outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground",
          )}
          aria-label={`Move ${task.title}`}
          aria-describedby={props.hintId}
          title="Drag, or Alt + arrow keys"
          onPointerDown={props.onPointerDown}
          onPointerMove={props.onPointerMove}
          onPointerUp={props.onPointerUp}
          onPointerCancel={props.onPointerCancel}
          onKeyDown={props.onKeyDown}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
        <div className="grid min-w-0 gap-2.5 py-3 pr-3 pl-1">
          <button
            type="button"
            onClick={props.onOpen}
            className="card-open grid min-w-0 cursor-pointer gap-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className={cn("flex items-start gap-2 text-sm font-medium [overflow-wrap:anywhere]", done && "font-normal text-muted-foreground")}>
              {done && <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden="true" />}
              {task.title}
            </span>
            {!done && task.description && (
              <span className="line-clamp-2 text-xs text-muted-foreground">{task.description}</span>
            )}
            {status && (
              <span className={cn("text-xs", retry ? "text-destructive" : "text-muted-foreground")}>{status}</span>
            )}
          </button>
          {step && (
            <div className="grid gap-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{step.label}</span>
                <span className="tabular-nums">
                  {step.index + 1} / {step.total}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`Step ${step.index + 1} of ${step.total}: ${step.label}`}
                aria-valuenow={((step.index + 1) / step.total) * 100}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1.5 overflow-hidden rounded-full bg-primary/15"
              >
                <div className="h-full bg-primary" style={{ width: `${((step.index + 1) / step.total) * 100}%` }} />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="tabular-nums">#{task.number}</span>
              <AgentBadge task={task} />
              {task.costUsd >= 0.005 && (
                <span
                  className="tabular-nums"
                  title="What this task's agent runs would cost at API prices. Your subscription covers it."
                >
                  ${task.costUsd.toFixed(2)}
                </span>
              )}
            </span>
            {action && (
              <Button size="sm" variant={retry ? "outline" : "default"} onClick={retry ? props.onStart : props.onOpen}>
                {retry && <RotateCcw aria-hidden="true" />}
                {action}
              </Button>
            )}
          </div>
        </div>
      </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={props.onOpen}>
          <ExternalLink aria-hidden="true" />
          Open
        </ContextMenuItem>
        {canStart(task) && (
          <ContextMenuItem onSelect={props.onStart}>
            <Play aria-hidden="true" />
            Start
          </ContextMenuItem>
        )}
        {retry && (
          <ContextMenuItem onSelect={props.onStart}>
            <RotateCcw aria-hidden="true" />
            Retry
          </ContextMenuItem>
        )}
        {isActive(task) && (
          <ContextMenuItem onSelect={props.onStop}>
            <Square aria-hidden="true" />
            Stop
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {LANES.filter((l) => l !== laneOf(task)).map((l) => (
              <ContextMenuItem key={l} onSelect={() => props.onMoveToLane(l)}>
                {LANE_LABELS[l]}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={props.onDelete}>
          <Trash2 aria-hidden="true" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
    </>
  );
}

// A zero-height item. The negative margins cancel the extra flex gap, so nothing shifts.
function DropMarker() {
  return (
    <li
      aria-hidden="true"
      className="relative -my-1 h-0 after:absolute after:inset-x-0 after:-top-px after:h-[3px] after:rounded-full after:bg-primary forced-colors:after:bg-[Highlight]"
    />
  );
}
