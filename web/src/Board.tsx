import { COLUMN_LABELS, COLUMNS, type Column, type Task, type TaskMove } from "@dot/shared";
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
import { GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AgentBadge } from "./AgentBadge.tsx";
import { byPosition } from "./move.ts";

// Plan review and merge approval wait for you, so they get the warm dot.
const COLUMN_DOT: Record<Column, string> = {
  inbox: "bg-muted-foreground/50",
  research: "bg-sky-500",
  plan_review: "bg-amber-500",
  execute: "bg-sky-500",
  review: "bg-sky-500",
  merge_approval: "bg-amber-500",
  merge: "bg-sky-500",
  done: "bg-emerald-500",
};

type DragState = {
  task: Task;
  pointerId: number;
  card: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  scrollStart: number;
  drop: TaskMove | null;
  frame: number;
  lastTime: number | null;
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sameMove = (a: TaskMove | null, b: TaskMove | null) =>
  a?.column === b?.column && a?.beforeTaskId === b?.beforeTaskId;

export function Board(props: {
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onMove: (task: Task, move: TaskMove) => void;
  announce: (message: string) => void;
}) {
  const { tasks, onMove, announce } = props;
  const boardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [drop, setDrop] = useState<TaskMove | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const hintId = useId();

  // After a move, animate the card from where it was (FLIP) and, for keyboard moves, keep focus on its handle.
  const pendingMove = useRef<{ id: number; from: DOMRect; keyboard: boolean } | null>(null);

  const columns = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c, [] as Task[]])) as Record<Column, Task[]>;
    for (const task of tasks) map[task.column].push(task);
    for (const list of Object.values(map)) list.sort(byPosition);
    return map;
  }, [tasks]);

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
      const list = columns[task.column];
      const position = list.findIndex((t) => t.id === task.id) + 1;
      announce(`Moved ${task.title} to ${COLUMN_LABELS[task.column]}, position ${position} of ${list.length}.`);
    }
  }, [tasks, columns, announce]);

  function commitMove(task: Task, move: TaskMove, card: HTMLElement, keyboard: boolean) {
    pendingMove.current = { id: task.id, from: card.getBoundingClientRect(), keyboard };
    onMove(task, move);
  }

  // The task that currently follows `task` in its column, so dropping right back into its own slot is a no-op.
  function nextSiblingId(task: Task): number | null {
    const list = columns[task.column];
    return list[list.findIndex((t) => t.id === task.id) + 1]?.id ?? null;
  }

  function findDrop(x: number, y: number, task: Task): TaskMove | null {
    // The dragged card has pointer-events: none, so this hits whatever is under it.
    const columnEl = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-column]");
    if (!columnEl) return null;
    const column = columnEl.dataset.column as Column;

    let beforeTaskId: number | null = null;
    for (const card of columnEl.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const id = Number(card.dataset.taskId);
      if (id === task.id) continue;
      const rect = card.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        beforeTaskId = id;
        break;
      }
    }

    if (column === task.column && beforeTaskId === nextSiblingId(task)) return null;
    return { column, beforeTaskId };
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
      commitMove(d.task, d.drop, d.card, false);
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
    const columnIndex = COLUMNS.indexOf(task.column);
    const list = columns[task.column];
    const index = list.findIndex((t) => t.id === task.id);
    let move: TaskMove | null = null;

    switch (e.key) {
      case "ArrowLeft": {
        const column = COLUMNS[columnIndex - 1];
        if (column) move = { column, beforeTaskId: null };
        break;
      }
      case "ArrowRight": {
        const column = COLUMNS[columnIndex + 1];
        if (column) move = { column, beforeTaskId: null };
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
    <div
      ref={boardRef}
      className="grid min-h-0 flex-1 auto-cols-[17rem] grid-flow-col grid-rows-[minmax(0,1fr)] gap-3 overflow-x-auto p-4"
    >
      <p id={hintId} hidden>
        Drag to move. Or press Alt with the arrow keys. Left and right change column, up and down change order.
      </p>
      {COLUMNS.map((column) => {
        const list = columns[column];
        const headingId = `${hintId}-${column}`;
        const markerBefore = drop?.column === column ? drop.beforeTaskId : undefined;
        return (
          <section
            key={column}
            data-column={column}
            aria-labelledby={headingId}
            className={cn(
              "grid min-h-0 grid-rows-[auto_1fr] rounded-xl bg-muted/60 ring-1 ring-transparent transition-shadow",
              drop?.column === column && "ring-2 ring-primary/50",
            )}
          >
            <header className="flex items-center justify-between px-3 pt-3 pb-2">
              <h2 id={headingId} className="flex items-center gap-2 text-sm font-medium">
                <span aria-hidden="true" className={cn("size-2 rounded-full", COLUMN_DOT[column])} />
                {COLUMN_LABELS[column]}
              </h2>
              <Badge variant="secondary" className="tabular-nums" aria-label={`${list.length} tasks`}>
                {list.length}
              </Badge>
            </header>
            <ol className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-3">
              {list.map((task) => (
                <TaskCardSlot
                  key={task.id}
                  task={task}
                  showMarker={markerBefore === task.id}
                  dragging={draggingId === task.id}
                  hintId={hintId}
                  onOpen={() => props.onOpenTask(task)}
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
  );
}

function TaskCardSlot(props: {
  task: Task;
  showMarker: boolean;
  dragging: boolean;
  hintId: string;
  onOpen: () => void;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { task } = props;
  return (
    <>
      {props.showMarker && <DropMarker />}
      <li
        data-task-id={task.id}
        data-dragging={props.dragging || undefined}
        className={cn(
          "relative grid scroll-m-3 grid-cols-[auto_minmax(0,1fr)] rounded-lg border bg-card text-card-foreground shadow-xs",
          "has-[.card-handle:focus-visible]:ring-3 has-[.card-handle:focus-visible]:ring-ring/50",
          "data-dragging:pointer-events-none data-dragging:z-10 data-dragging:scale-[1.02] data-dragging:shadow-xl",
        )}
      >
        <button
          type="button"
          className={cn(
            "card-handle grid w-6 cursor-grab touch-none place-items-center rounded-l-lg text-muted-foreground/60 select-none",
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
        <button
          type="button"
          onClick={props.onOpen}
          className="card-open grid min-w-0 cursor-pointer gap-1 rounded-r-lg py-2.5 pr-3 pl-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{task.title}</span>
          {task.description && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{task.description}</span>
          )}
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">#{task.number}</span>
            <AgentBadge task={task} />
          </span>
        </button>
      </li>
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
