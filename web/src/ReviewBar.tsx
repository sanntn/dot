import { Check, CornerUpLeft } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// The bar at the foot of a plan or report that waits for you: approve it, or send it back with notes.
export function ReviewBar(props: {
  // Who gets the notes, for the label: "researcher", "agent".
  agent: string;
  approveLabel: string;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  // Returns true when the notes were sent, so the form can close and clear.
  onSendBack: (notes: string) => Promise<boolean>;
}) {
  const [sendingBack, setSendingBack] = useState(false);
  const [notes, setNotes] = useState("");
  const notesId = useId();

  return (
    <div className="grid gap-3 border-t bg-background p-3">
      {props.error && (
        <Alert variant="destructive">
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      )}
      {sendingBack ? (
        <form
          className="grid gap-2"
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            if (await props.onSendBack(notes)) {
              setNotes("");
              setSendingBack(false);
            }
          }}
        >
          <Label htmlFor={notesId}>What should the {props.agent} change?</Label>
          <Textarea id={notesId} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus required className="max-h-48 min-h-20" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setSendingBack(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy || !notes.trim()}>
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
          <Button type="button" disabled={props.busy} onClick={props.onApprove}>
            <Check aria-hidden="true" />
            {props.approveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
