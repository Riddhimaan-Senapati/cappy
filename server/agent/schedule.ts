import * as chrono from "chrono-node";
import { addSeconds } from "date-fns";
import type { Change, Schedule } from "../../shared/adaptation.js";

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const WINDOW = new RegExp(String.raw`\b(?:between|from)\s+${TIME}\s+(?:and|to)\s+${TIME}`, "i");

const clock = (hour: string, minute: string | undefined, half: string | undefined) => {
  let h = Number(hour) % 24;
  if (half?.toLowerCase() === "pm" && h < 12) h += 12;
  if (half?.toLowerCase() === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${minute ?? "00"}`;
};

// Chrono finds the phrase ("next 30 seconds"); date-fns turns the count into an exact end instant.
function spanSeconds(text: string): number | null {
  const match = text.match(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = match[2].toLowerCase()[0];
  return count * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
}

const dateStamp = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// Saturday through Sunday of the weekend that contains today, or the next one when today is a weekday.
function oneWeekend(now: Date): { from: string; until: string } {
  const day = now.getDay();
  const saturday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (day === 0 ? -1 : 6 - day));
  const sunday = new Date(saturday.getFullYear(), saturday.getMonth(), saturday.getDate() + 1);
  return { from: dateStamp(saturday), until: dateStamp(sunday) };
}

// "for the next 30 seconds" becomes an absolute end. "on weekends" repeats. "this weekend" is one Saturday and Sunday.
export function parseSpokenSchedule(message: string, now = new Date()): Schedule | null {
  const window = message.match(WINDOW);
  const once = /\bthis weekend\b/i.test(message);
  const days = once ? null : /\bweekdays?\b/i.test(message) ? (["mon", "tue", "wed", "thu", "fri"] as const) : /\bweekends?\b/i.test(message) ? (["sat", "sun"] as const) : null;
  const relative = chrono.parse(message, now, { forwardDate: true }).find((result) => spanSeconds(result.text) != null);
  const seconds = relative ? spanSeconds(relative.text) : null;
  const untilAt = seconds != null ? addSeconds(now, seconds).toISOString() : null;
  const span = once && !untilAt ? oneWeekend(now) : null;
  if (!window && !days && !untilAt && !span) return null;
  return {
    days: days ? [...days] : null,
    start: window && !untilAt ? clock(window[1], window[2], window[3]) : null,
    end: window && !untilAt ? clock(window[4], window[5], window[6]) : null,
    ...(span ?? {}),
    ...(untilAt ? { untilAt } : {}),
  };
}

// The user's words win over a clock the model guessed. A short span replaces the whole schedule.
export function withSpokenSchedule(change: Change, message: string, now = new Date()): Change {
  const spoken = parseSpokenSchedule(message, now);
  if (!spoken) return change;
  if (spoken.untilAt) return { ...change, schedule: spoken };
  const previous = change.schedule;
  const once = spoken.from != null || spoken.until != null;
  return {
    ...change,
    schedule: {
      days: once ? spoken.days ?? null : spoken.days ?? previous?.days ?? null,
      start: spoken.start ?? previous?.start ?? null,
      end: spoken.end ?? previous?.end ?? null,
      from: spoken.from ?? previous?.from ?? null,
      until: spoken.until ?? previous?.until ?? null,
      ...(previous?.untilAt ? { untilAt: previous.untilAt } : {}),
    },
  };
}
