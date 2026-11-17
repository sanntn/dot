import type { Task } from "@dot/shared";
import { CircleAlert, Clock, Loader2, MessageCircleQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// What the task's agent is doing, shown on cards and in the task panel.
export function AgentBadge({ task }: { task: Task }) {
  if (task.agentState === "running") {
    return (
      <Badge variant="secondary">
        <Loader2 className="animate-spin" aria-hidden="true" />
        Working
      </Badge>
    );
  }
  if (task.agentState === "queued") {
    return (
      <Badge variant="outline">
        <Clock aria-hidden="true" />
        Queued
      </Badge>
    );
  }
  if (task.agentState === "failed") {
    return (
      <Badge variant="destructive">
        <CircleAlert aria-hidden="true" />
        Failed
      </Badge>
    );
  }
  if (task.needsInput) {
    return (
      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
        <MessageCircleQuestion aria-hidden="true" />
        Needs input
      </Badge>
    );
  }
  return null;
}
