import { z } from "zod";
import { DEFAULT_KIND, TASK_KINDS } from "./kinds.ts";

// A schedule creates a task in a project on a fixed rhythm and starts its research by itself.
export const FREQUENCIES = ["hourly", "daily", "weekly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const ScheduleInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  kind: z.enum(TASK_KINDS).default(DEFAULT_KIND),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().max(20000).default(""),
  frequency: z.enum(FREQUENCIES).default("daily"),
  // Server local time. Hourly uses only the minute, weekly also uses the weekday (0 is Sunday).
  hour: z.number().int().min(0).max(23).default(9),
  minute: z.number().int().min(0).max(59).default(0),
  weekday: z.number().int().min(0).max(6).default(1),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.input<typeof ScheduleInputSchema>;

// Written out field by field. Making the input schema partial would keep its defaults, and a patch of one
// field would then reset the others.
export const SchedulePatchSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100).optional(),
    title: z.string().trim().min(1, "Title is required").max(200).optional(),
    description: z.string().max(20000).optional(),
    frequency: z.enum(FREQUENCIES).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "Nothing to change" });
export type SchedulePatch = z.input<typeof SchedulePatchSchema>;

export type Schedule = {
  id: number;
  projectId: number;
  name: string;
  kind: (typeof TASK_KINDS)[number];
  title: string;
  description: string;
  frequency: Frequency;
  hour: number;
  minute: number;
  weekday: number;
  enabled: boolean;
  // When it fires next. Null while it is off.
  nextRunAt: string | null;
  lastRunAt: string | null;
  // The task the last firing made, if it still exists.
  lastTaskId: number | null;
  // Why the last firing made no task, such as the previous task still being open.
  lastNote: string;
  createdAt: string;
};

type Rhythm = Pick<Schedule, "frequency" | "hour" | "minute" | "weekday">;

// The first moment after `from` that matches the rhythm, in the local time of the machine running the code.
// Around a clock change a time that does not exist moves to the next one that does, such as 02:30 to 03:30.
export function nextRun(rhythm: Rhythm, from: Date): Date {
  const next = new Date(from.getTime());
  next.setSeconds(0, 0);
  if (rhythm.frequency === "hourly") {
    next.setMinutes(rhythm.minute);
    if (next <= from) next.setHours(next.getHours() + 1);
    return next;
  }
  next.setHours(rhythm.hour, rhythm.minute);
  if (rhythm.frequency === "weekly") {
    next.setDate(next.getDate() + ((rhythm.weekday - next.getDay() + 7) % 7));
    if (next <= from) next.setDate(next.getDate() + 7);
    return next;
  }
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}
