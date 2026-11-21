import type { Project } from "@dot/shared";
import { useEffect, useRef, useState } from "react";

export const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

// "all" or a project id. The views start on the project you are looking at.
export type Scope = "all" | string;
export const scopeProjectId = (scope: Scope): number | undefined => (scope === "all" ? undefined : Number(scope));

// A view's scope starts on the header's project and follows it when you change it there. "All projects" is
// your own choice, so it stays until you change it.
export function useScope(currentId: number | null) {
  const [scope, setScope] = useState<Scope>(currentId === null ? "all" : String(currentId));
  const last = useRef(currentId);
  useEffect(() => {
    if (last.current === currentId) return;
    last.current = currentId;
    setScope((s) => (s === "all" || currentId === null ? s : String(currentId)));
  }, [currentId]);
  return [scope, setScope] as const;
}

export function ScopeSelect(props: { projects: Project[]; value: Scope; onChange: (scope: Scope) => void }) {
  return (
    <select aria-label="Project" className={selectClass} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="all">All projects</option>
      {props.projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
