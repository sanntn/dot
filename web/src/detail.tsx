import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Prose } from "./Prose.tsx";

// Agents write a lot. By default the panels show the main points and fold the rest away.
// This preference turns every fold open. It is kept per browser, like the notifications one.
const KEY = "dot.fullDetail";
const listeners = new Set<() => void>();
let memory = false;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return memory;
  }
}

export function setFullDetail(on: boolean): void {
  memory = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Storage can be blocked. The setting then lasts until the page reloads.
  }
  listeners.forEach((fn) => fn());
}

export function useFullDetail(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read,
    () => false,
  );
}

// Content that stays folded until you ask for it. `label` names what is inside, for example
// "Context, 4 files, 7 steps". With full detail on, it is simply shown.
export function MoreDetails({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const full = useFullDetail();
  const [open, setOpen] = useState(false);
  if (full) return <div className={cn("grid gap-4", className)}>{children}</div>;
  return (
    <div className={cn("grid gap-4", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
        {open ? "Hide details" : `Show details: ${label}`}
      </button>
      {open && children}
    </div>
  );
}

// Markdown that is cut off after `maxHeight` when it runs long, with a button to read the rest.
export function ClampedProse({ children, className, maxHeight = 176 }: { children: string; className?: string; maxHeight?: number }) {
  const full = useFullDetail();
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (el) setOverflows(el.scrollHeight > maxHeight + 8);
  }, [children, maxHeight]);

  const clamped = overflows && !open && !full;
  return (
    <div className="grid min-w-0 gap-1">
      <div
        ref={box}
        className="relative min-w-0 overflow-hidden"
        style={clamped ? { maxHeight } : undefined}
      >
        <Prose className={className}>{children}</Prose>
        {clamped && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {overflows && !full && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="w-fit rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// The one-sentence point of a plan, report or review. It leads the panel.
export function Headline({ children }: { children: string }) {
  return <p className="text-base leading-snug font-medium text-balance">{children}</p>;
}
