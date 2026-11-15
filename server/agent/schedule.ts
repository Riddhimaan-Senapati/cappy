import * as chrono from "chrono-node";
import { addSeconds } from "date-fns";
import type { Change, Schedule } from "../../shared/adaptation.js";

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const SEP = String.raw`\s*(?:and|to|until|till|-)\s*`;
const DAYS = String.raw`(?:weekdays?|weekends?|daily|every\s*day|nights?|mornings?|evenings?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)`;
// "between 9 and 5", "from 9 to 5", or a bare "9 to 5" right after a day word ("weekdays 9-5").
const WINDOW = new RegExp(String.raw`\b(?:between|from)\s+${TIME}${SEP}${TIME}`, "i");
const DAY_WINDOW = new RegExp(String.raw`\b${DAYS}\s+${TIME}${SEP}${TIME}`, "i");
// "9am-5pm" or "09:00 to 17:00" anywhere: a stated half or both clocks make it a time window.
const MARKED_WINDOW = new RegExp(String.raw`\b${TIME}\s*(?:to|-)\s*${TIME}`, "i");

const COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45, "forty five": 45, ninety: 90, "a few": 3, "a couple of": 2,
};
const COUNT = String.raw`(\d+(?:\.\d+)?|a couple of|a few|forty[- ]five|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|ninety)`;
const UNIT = String.raw`(seconds?|secs?|minutes?|mins?|hours?|hrs?)`;
// A span needs "for" or "next" in front, so "hide 5 minute videos" is not a time limit.
const SPAN = new RegExp(String.raw`\b(?:for|next)\s+(?:the\s+)?(?:next\s+)?(?:(half\s+an?\s+hour)|${COUNT}\s*${UNIT}(\s+and\s+a\s+half)?)\b`, "i");
const UNTIL = /\b(?:until|till|til)\s+(.+)/i;

const unitSeconds = (unit: string) => (unit[0].toLowerCase() === "h" ? 3600 : unit[0].toLowerCase() === "m" ? 60 : 1);

function spanSeconds(text: string): number | null {
  const match = text.replace(/\bnext\s+(hour|minute|second)\b/i, "next 1 $1").match(SPAN);
  if (!match) return null;
  if (match[1]) return 1800;
  const raw = match[2].toLowerCase().replace(/\s+/g, " ");
  const count = /^\d/.test(raw) ? Number(raw) : COUNT_WORDS[raw.replace("forty-five", "forty five")] ?? COUNT_WORDS[raw];
  if (!Number.isFinite(count) || count <= 0) return null;
  const seconds = (count + (match[4] ? 0.5 : 0)) * unitSeconds(match[3]);
  return Math.round(seconds);
}

// "until 5pm", "until noon": the next time that clock comes round. A date ("until December 15") is left to the model.
function untilInstant(text: string, now: Date): Date | null {
  const tail = text.match(UNTIL)?.[1];
  if (!tail) return null;
  const found = chrono.parse(tail, now, { forwardDate: true })[0];
  if (!found || found.index > 0 || !found.start.isCertain("hour")) return null;
  const at = found.start.date();
  return at.getTime() > now.getTime() ? at : null;
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const toClock = (total: number) => `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
const length = (start: number, end: number) => (end - start + 1440) % 1440 || 1440;

type Side = { hour: number; minute: number; half: "am" | "pm" | null; written: string };

function side(hour: string, minute: string | undefined, half: string | undefined): Side {
  const mark = half?.toLowerCase().replace(/\./g, "");
  return { hour: Number(hour), minute: Number(minute ?? 0), half: mark === "am" || mark === "pm" ? mark : null, written: hour };
}

// A 24-hour reading ("17", "09", "0") or a stated half fixes the clock. Otherwise it could be am or pm.
function choices(s: Side): number[] {
  if (s.half === "pm") return [((s.hour % 12) + 12) * 60 + s.minute];
  if (s.half === "am") return [(s.hour % 12) * 60 + s.minute];
  if (s.hour > 12 || s.hour === 0 || /^0\d/.test(s.written)) return [(s.hour % 24) * 60 + s.minute];
  return [(s.hour % 12) * 60 + s.minute, ((s.hour % 12) + 12) * 60 + s.minute];
}

// "9 to 5" is 9:00 to 17:00, not 9:00 to 5:00 the next morning: an unstated half takes the shorter span.
function resolveWindow(a: Side, b: Side): { start: string; end: string; ambiguous: boolean } {
  const starts = choices(a);
  const ends = choices(b);
  let start: number;
  if (starts.length === 1) start = starts[0];
  else if (ends.length === 1) start = starts.reduce((best, s) => (length(s, ends[0]) < length(best, ends[0]) ? s : best));
  else start = a.hour % 12 < 7 && a.hour !== 12 ? starts[1] : a.hour === 12 ? 12 * 60 + a.minute : starts[0];
  const end = ends.reduce((best, e) => (length(start, e) < length(start, best) ? e : best));
  return { start: toClock(start), end: toClock(end), ambiguous: starts.length > 1 && ends.length > 1 };
}

function spokenWindow(message: string): { start: string; end: string; ambiguous: boolean } | null {
  const match = message.match(WINDOW) ?? message.match(DAY_WINDOW);
  if (match) return resolveWindow(side(match[1], match[2], match[3]), side(match[4], match[5], match[6]));
  const marked = message.match(MARKED_WINDOW);
  if (!marked) return null;
  const a = side(marked[1], marked[2], marked[3]);
  const b = side(marked[4], marked[5], marked[6]);
  const clocks = marked[2] != null && marked[5] != null;
  if (!a.half && !b.half && !clocks) return null;
  return resolveWindow(a, b);
}

const dateStamp = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// Saturday through Sunday of the weekend that contains today, or the next one when today is a weekday.
function oneWeekend(now: Date): { from: string; until: string } {
  const day = now.getDay();
  const saturday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (day === 0 ? -1 : 6 - day));
  const sunday = new Date(saturday.getFullYear(), saturday.getMonth(), saturday.getDate() + 1);
  return { from: dateStamp(saturday), until: dateStamp(sunday) };
}

function readSpoken(message: string, now: Date): { schedule: Schedule; ambiguousClock: boolean } | null {
  const window = spokenWindow(message);
  const once = /\bthis weekend\b/i.test(message);
  const days = once ? null : /\bweekdays?\b/i.test(message) ? (["mon", "tue", "wed", "thu", "fri"] as const) : /\bweekends?\b/i.test(message) ? (["sat", "sun"] as const) : null;
  const seconds = spanSeconds(message);
  const end = seconds != null ? addSeconds(now, seconds) : untilInstant(message, now);
  const untilAt = end ? end.toISOString() : null;
  const span = once && !untilAt ? oneWeekend(now) : null;
  if (!window && !days && !untilAt && !span) return null;
  return {
    schedule: {
      days: days ? [...days] : null,
      start: window && !untilAt ? window.start : null,
      end: window && !untilAt ? window.end : null,
      ...(span ?? {}),
      ...(untilAt ? { untilAt } : {}),
    },
    ambiguousClock: Boolean(window?.ambiguous) && !untilAt,
  };
}

// "for the next 30 seconds", "for an hour" and "until 5pm" become an absolute end. "on weekends" repeats. "this weekend" is one Saturday and Sunday.
export function parseSpokenSchedule(message: string, now = new Date()): Schedule | null {
  return readSpoken(message, now)?.schedule ?? null;
}

const sameOnTheDial = (a: string, b: string) => minutesOf(a) % 720 === minutesOf(b) % 720;

// The user's words win over a clock the model guessed. A short span replaces the whole schedule.
// For "from 8 to 6" with no am or pm, a model reading of the same hours (20:00 to 6:00) is kept, since it saw the context.
export function withSpokenSchedule(change: Change, message: string, now = new Date()): Change {
  const read = readSpoken(message, now);
  if (!read) return change;
  const spoken = read.schedule;
  if (spoken.untilAt) return { ...change, schedule: spoken };
  const previous = change.schedule;
  const once = spoken.from != null || spoken.until != null;
  const keepModelClock =
    read.ambiguousClock && previous?.start != null && previous.end != null && spoken.start != null && spoken.end != null &&
    sameOnTheDial(previous.start, spoken.start) && sameOnTheDial(previous.end, spoken.end);
  return {
    ...change,
    schedule: {
      days: once ? spoken.days ?? null : spoken.days ?? previous?.days ?? null,
      start: keepModelClock ? previous!.start : spoken.start ?? previous?.start ?? null,
      end: keepModelClock ? previous!.end : spoken.end ?? previous?.end ?? null,
      from: spoken.from ?? previous?.from ?? null,
      until: spoken.until ?? previous?.until ?? null,
      ...(previous?.untilAt ? { untilAt: previous.untilAt } : {}),
    },
  };
}
