import type { Task } from "@dot/shared";

// Checkbox list of the tasks this one can wait on. Used by the New task dialog and the Details tab.
export function BlockerPicker(props: {
  candidates: Task[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  if (props.candidates.length === 0) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">Blocked by</legend>
      <p className="text-xs text-muted-foreground">The task cannot start until these are done.</p>
      <ul className="grid max-h-32 gap-1 overflow-y-auto rounded-md border p-2">
        {props.candidates.map((t) => (
          <li key={t.id}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={props.value.includes(t.id)}
                onChange={(e) =>
                  props.onChange(e.target.checked ? [...props.value, t.id] : props.value.filter((x) => x !== t.id))
                }
              />
              <span className="tabular-nums text-muted-foreground">#{t.number}</span>
              <span className="truncate">{t.title}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
