import { z } from "zod";

export const Day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Day = z.infer<typeof Day>;

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 24-hour");
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const Schedule = z
  .object({
    days: z.array(Day).min(1).max(7).optional(),
    start: Clock.optional(),
    end: Clock.optional(),
    from: DateOnly.optional(),
    until: DateOnly.optional(),
  })
  .strict()
  .refine((s) => Object.values(s).some((v) => v !== undefined), "schedule needs at least one field")
  .refine((s) => (s.start === undefined) === (s.end === undefined), "start and end go together")
  .refine((s) => !s.from || !s.until || s.from <= s.until, "from must not be after until");
export type Schedule = z.infer<typeof Schedule>;

const DAY_INDEX: readonly Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function minutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Times and dates are the user's local wall clock. An overnight range (22:00-06:00) belongs to the day it starts on.
export function isScheduleActive(schedule: Schedule | undefined, now: Date): boolean {
  if (!schedule) return true;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let day = new Date(now);
  if (schedule.start && schedule.end) {
    const s = minutes(schedule.start);
    const e = minutes(schedule.end);
    if (s === e) return false;
    const overnight = s > e;
    const inWindow = overnight ? nowMin >= s || nowMin < e : nowMin >= s && nowMin < e;
    if (!inWindow) return false;
    if (overnight && nowMin < e) day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
  const date = localDate(day);
  if (schedule.from && date < schedule.from) return false;
  if (schedule.until && date > schedule.until) return false;
  if (schedule.days && !schedule.days.includes(DAY_INDEX[day.getDay()]!)) return false;
  return true;
}

export function describeSchedule(schedule: Schedule | undefined): string {
  if (!schedule) return "Always";
  const parts: string[] = [];
  const days = schedule.days;
  if (days) {
    const set = new Set(days);
    if (days.length === 5 && ["mon", "tue", "wed", "thu", "fri"].every((d) => set.has(d as Day))) parts.push("Weekdays");
    else if (days.length === 2 && set.has("sat") && set.has("sun")) parts.push("Weekends");
    else parts.push(days.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", "));
  }
  if (schedule.start && schedule.end) parts.push(`${schedule.start}–${schedule.end}`);
  if (schedule.from && schedule.until) parts.push(`${schedule.from} to ${schedule.until}`);
  else if (schedule.from) parts.push(`from ${schedule.from}`);
  else if (schedule.until) parts.push(`until ${schedule.until}`);
  return parts.join(", ");
}
