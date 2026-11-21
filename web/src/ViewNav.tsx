import { cn } from "@/lib/utils";
import { VIEWS, VIEW_LABELS, type View } from "./views.ts";

export function ViewNav({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <nav aria-label="Views" className="flex gap-1 overflow-x-auto border-b bg-background px-4 py-1.5">
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          aria-current={v === view ? "page" : undefined}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            v === view && "bg-muted font-medium text-foreground",
          )}
        >
          {VIEW_LABELS[v]}
        </button>
      ))}
    </nav>
  );
}
