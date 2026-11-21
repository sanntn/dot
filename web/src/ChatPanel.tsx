import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  stageLabel,
  type AgentStage,
  type AttachmentRef,
  type ChatKind,
  type ChatMessage,
  type Task,
} from "@dot/shared";
import {
  CircleAlert,
  ClipboardCheck,
  FileText,
  GitBranch,
  ImagePlus,
  ListChecks,
  Loader2,
  SendHorizontal,
  Wrench,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, attachmentUrl, errorMessage } from "./api.ts";
import { ClampedProse } from "./detail.tsx";
import { Prose } from "./Prose.tsx";

export type ArtifactTab = "plan" | "report" | "proposals" | "changes" | "review";

// Chat messages that announce an artifact get a card with a button to open its tab.
const ARTIFACT_CARDS: Partial<Record<ChatKind, { icon: typeof FileText; tab: ArtifactTab; label: string }>> = {
  plan: { icon: FileText, tab: "plan", label: "View plan" },
  document: { icon: FileText, tab: "report", label: "View report" },
  proposals: { icon: ListChecks, tab: "proposals", label: "View proposals" },
  report: { icon: GitBranch, tab: "changes", label: "View changes" },
  review: { icon: ClipboardCheck, tab: "review", label: "View review" },
};

type Draft = { key: string; preview: string; fileName: string; ref: AttachmentRef | null; error: string | null };

export function ChatPanel(props: {
  task: Task;
  stage: AgentStage;
  messages: ChatMessage[];
  hasRun: boolean;
  onView: (tab: ArtifactTab) => void;
}) {
  const { task, stage, messages, hasRun } = props;
  const agentName = stageLabel(task.kind, stage).toLowerCase();
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Keep the view pinned to the newest message unless the user scrolled up to read.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  // Release image previews when the panel closes. A ref, because the cleanup must see the latest drafts.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(() => () => draftsRef.current.forEach((d) => URL.revokeObjectURL(d.preview)), []);

  // A question is answered once you replied to the same agent after it.
  const answered = useMemo(() => {
    const ids = new Set<number>();
    const open: ChatMessage[] = [];
    for (const m of messages) {
      if (m.kind === "question") open.push(m);
      else if (m.role === "user") {
        for (const q of open) if (q.runId === m.runId) ids.add(q.id);
      }
    }
    return ids;
  }, [messages]);

  function onScroll() {
    const list = listRef.current;
    if (list) stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  }

  function addFiles(files: File[]) {
    for (const file of files) {
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      let problem: string | null = null;
      if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) problem = "Only PNG, JPEG, GIF and WebP";
      else if (file.size > MAX_IMAGE_BYTES) problem = "Larger than 5 MB";
      setDrafts((prev) => [...prev, { key, preview, fileName: file.name || "image", ref: null, error: problem }]);
      if (problem) continue;
      api
        .uploadAttachment(task.id, file)
        .then((ref) => setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ref } : d))))
        .catch((err) => setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, error: errorMessage(err) } : d))));
    }
  }

  function removeDraft(key: string) {
    setDrafts((prev) => {
      const draft = prev.find((d) => d.key === key);
      if (draft) URL.revokeObjectURL(draft.preview);
      return prev.filter((d) => d.key !== key);
    });
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    addFiles(images);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  }

  const uploading = drafts.some((d) => !d.ref && !d.error);
  const ready = drafts.filter((d) => d.ref);
  const canSend = hasRun && !sending && !uploading && (text.trim() !== "" || ready.length > 0);

  async function sendText(body: string, attachmentIds: number[]) {
    setSending(true);
    setError(null);
    try {
      await api.sendMessage(task.id, { stage, text: body, attachmentIds });
      stickToBottom.current = true;
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    if (!canSend) return;
    const ok = await sendText(text, ready.map((d) => d.ref!.id));
    if (ok) {
      setText("");
      drafts.forEach((d) => URL.revokeObjectURL(d.preview));
      setDrafts([]);
    }
  }

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", dragging && "ring-2 ring-primary/50 ring-inset")}
      onDragOver={(e) => {
        if (!hasRun || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div ref={listRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="m-auto max-w-sm text-center text-sm text-muted-foreground">
            {hasRun
              ? `No messages yet.`
              : `The ${agentName} hasn't started yet. Once it does, you can chat with it here while it works.`}
          </p>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            answered={answered.has(m.id)}
            canAnswer={hasRun && !sending}
            onAnswer={(choice) => void sendText(choice, [])}
            onView={props.onView}
          />
        ))}
      </div>

      <form
        className="border-t bg-background p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {drafts.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2">
            {drafts.map((d) => (
              <li key={d.key} className="relative">
                <img
                  src={d.preview}
                  alt={d.fileName}
                  className={cn("size-16 rounded-md border object-cover", d.error && "opacity-40")}
                />
                {!d.ref && !d.error && (
                  <Loader2 className="absolute inset-0 m-auto size-5 animate-spin text-foreground" aria-label="Uploading" />
                )}
                {d.error && (
                  <span className="absolute inset-x-0 bottom-0 rounded-b-md bg-destructive/90 px-1 text-[10px] leading-4 text-white">
                    {d.error}
                  </span>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -top-2 -right-2 rounded-full"
                  aria-label={`Remove ${d.fileName}`}
                  onClick={() => removeDraft(d.key)}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <label htmlFor={inputId} className="sr-only">
          Message the {agentName}
        </label>
        <Textarea
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={!hasRun}
          placeholder={hasRun ? `Message the ${agentName}. Paste or drop images.` : `The ${agentName} hasn't started yet`}
          className="max-h-64 min-h-20 resize-y"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasRun}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = IMAGE_TYPES.join(",");
              input.multiple = true;
              input.onchange = () => addFiles([...(input.files ?? [])]);
              input.click();
            }}
          >
            <ImagePlus aria-hidden="true" />
            Add image
          </Button>
          <span className="flex-1 text-xs text-muted-foreground">Ctrl + Enter to send</span>
          <Button type="submit" size="sm" disabled={!canSend}>
            {sending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
            Send
          </Button>
        </div>
      </form>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/70 text-sm font-medium">
          Drop images to attach
        </div>
      )}
    </div>
  );
}

function MessageView(props: {
  message: ChatMessage;
  answered: boolean;
  canAnswer: boolean;
  onAnswer: (choice: string) => void;
  onView: (tab: ArtifactTab) => void;
}) {
  const { message: m } = props;

  if (m.role === "user") {
    return (
      <div className="ml-auto grid max-w-[85%] justify-items-end gap-2">
        {m.data?.attachments && (
          <div className="flex flex-wrap justify-end gap-2">
            {m.data.attachments.map((a) => (
              <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer">
                <img src={attachmentUrl(a.id)} alt={a.fileName} className="max-h-40 rounded-lg border object-contain" />
              </a>
            ))}
          </div>
        )}
        {m.text && (
          <div className="rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
            {m.text}
          </div>
        )}
      </div>
    );
  }

  if (m.kind === "tool") {
    return (
      <p className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
        <Wrench className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span className="[overflow-wrap:anywhere]">{m.text}</span>
      </p>
    );
  }

  if (m.kind === "error") {
    return (
      <p
        className={cn(
          "flex items-start gap-2 text-destructive",
          m.role === "tool" ? "font-mono text-xs" : "rounded-lg border border-destructive/30 p-3 text-sm",
        )}
      >
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</span>
      </p>
    );
  }

  if (m.kind === "status" && m.text.includes(String.fromCharCode(10))) {
    // A longer status, such as the project check results, reads as a block.
    return (
      <div className="rounded-lg border p-3">
        <ClampedProse className="text-xs text-muted-foreground" maxHeight={160}>
          {m.text}
        </ClampedProse>
      </div>
    );
  }

  if (m.kind === "status") {
    // A preview posts its screenshot as an attachment on the status line.
    const pictures = m.data?.attachments ?? [];
    if (pictures.length > 0) {
      return (
        <div className="grid gap-2">
          {pictures.map((a) => (
            <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" className="block">
              <img src={attachmentUrl(a.id)} alt={a.fileName} className="w-full rounded-lg border object-contain" />
            </a>
          ))}
          <p className="text-center text-xs text-muted-foreground">{m.text}</p>
        </div>
      );
    }
    return <p className="text-center text-xs text-muted-foreground">{m.text}</p>;
  }

  if (m.kind === "question") {
    const open = !props.answered && !m.data?.answered;
    return (
      <div className="grid gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Question for you</p>
        <Prose className="text-sm">{m.text}</Prose>
        {open && m.data?.choices && (
          <div className="flex flex-wrap gap-2">
            {m.data.choices.map((choice) => (
              <Button
                key={choice}
                type="button"
                variant="outline"
                size="sm"
                disabled={!props.canAnswer}
                onClick={() => props.onAnswer(choice)}
                className="h-auto min-h-7 max-w-full min-w-0 py-1 text-left whitespace-normal [overflow-wrap:anywhere]"
              >
                {choice}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const artifactCard = ARTIFACT_CARDS[m.kind];
  if (artifactCard) {
    const { icon: Icon, tab, label } = artifactCard;
    return (
      <div className="flex items-center gap-3 rounded-xl border p-3">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 text-sm font-medium">{m.text}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => props.onView(tab)}>
          {label}
        </Button>
      </div>
    );
  }

  // Long agent replies are cut after about ten lines. A question stays whole, because you answer it.
  return <ClampedProse className="text-sm" maxHeight={240}>{m.text}</ClampedProse>;
}
