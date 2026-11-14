// Kept free of zod so the content script stays small.
import type { Change } from "./adaptation.js";

export const SAFE_ATTRIBUTES = [
  "aria-label",
  "aria-hidden",
  "aria-describedby",
  "alt",
  "title",
  "role",
  "tabindex",
  "lang",
  "autocomplete",
  "inputmode",
] as const;

export const REMOVABLE_ATTRIBUTES = ["autoplay", "loop", "tabindex", "aria-hidden", "disabled", "readonly"] as const;


const DOM_OPS = new Set(["addLabel", "setAttribute", "removeAttribute", "pauseMedia"]);
const BLOCKS = new Set(["colorblind", "textScale", "stopMotion", "darkMode", "contentFilter", "formFixer"]);

const FORBIDDEN_CSS: Array<[RegExp, string]> = [
  [/url\s*\(/i, "url() can load outside resources"],
  [/@import/i, "@import can load outside resources"],
  [/@font-face/i, "@font-face can load outside resources"],
  [/image-set\s*\(/i, "image-set() can load outside resources"],
  [/expression\s*\(/i, "expression() runs script"],
  [/javascript:/i, "javascript: URLs"],
  [/-moz-binding|behavior\s*:/i, "script bindings"],
  [/<\/?style|<script/i, "markup inside CSS"],
  [/\\/, "CSS escapes can hide forbidden tokens"],
];

const SAFE_CONTENT_VALUES = new Set(["none", "normal", '""', "''"]);

export const LIMITS = { cssChars: 6000, changes: 8, domOps: 40, labelChars: 80, attrChars: 200 };

export function scanCss(css: string): string | null {
  if (css.length > LIMITS.cssChars) return `CSS longer than ${LIMITS.cssChars} characters`;
  const hit = FORBIDDEN_CSS.find(([pattern]) => pattern.test(css));
  if (hit) return hit[1];
  for (const match of css.matchAll(/(?<![-\w])content\s*:\s*([^;}]*)/gi)) {
    const value = match[1].replace(/!important/i, "").trim();
    if (!SAFE_CONTENT_VALUES.has(value)) return "content: can paint fake text on the page";
  }
  return null;
}

export function validateChange(change: Change): string | null {
  if (change.scope !== "site" && change.scope !== "everywhere") return "bad scope";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(change.id)) return `bad id "${change.id}"`;
  if (!change.css && !change.dom?.length && !change.block) return "change does nothing";
  if (change.css) {
    const problem = scanCss(change.css);
    if (problem) return `CSS rejected: ${problem}`;
  }
  if (change.dom && change.dom.length > LIMITS.domOps) return "too many DOM operations";
  for (const op of change.dom ?? []) {
    if (!DOM_OPS.has(op.op) || typeof op.selector !== "string") return `unknown DOM op "${op.op}"`;
    if (op.op === "setAttribute" && !(SAFE_ATTRIBUTES as readonly string[]).includes(op.name)) return `attribute "${op.name}" not allowed`;
    if (op.op === "removeAttribute" && !(REMOVABLE_ATTRIBUTES as readonly string[]).includes(op.name)) return `attribute "${op.name}" not removable`;
    if (op.op === "addLabel" && op.text.length > LIMITS.labelChars) return "label text too long";
    if (op.op === "setAttribute" && op.value.length > LIMITS.attrChars) return "attribute value too long";
  }
  if (change.block && !BLOCKS.has(change.block.name)) return `unknown block "${change.block.name}"`;
  if (change.block?.name === "formFixer") {
    const { minTargetPx, addLabels, clearErrors, oneQuestionMode } = change.block;
    if (!Number.isInteger(minTargetPx) || minTargetPx < 24 || minTargetPx > 64) return "form target size must be 24 to 64 whole pixels";
    if ([addLabels, clearErrors, oneQuestionMode].some((option) => typeof option !== "boolean")) return "form options must be boolean";
  }
  if (change.block?.name === "contentFilter") {
    const { keywords, itemSelector } = change.block;
    if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 12) return "filter needs 1 to 12 keywords";
    if (keywords.some((k) => typeof k !== "string" || k.trim().length < 2 || k.length > 40)) return "filter keyword must be 2 to 40 characters";
    if (itemSelector != null && (itemSelector.length > 160 || /[{};@\\<]/.test(itemSelector))) return "filter selector not allowed";
  }
  if (change.schedule) {
    const problem = scheduleProblem(change.schedule);
    if (problem) return problem;
  }
  if (change.block?.name === "textScale") {
    change.block.scale = Math.min(2, Math.max(1, Number(change.block.scale) || 1));
  }
  return null;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_INDEX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type ScheduleLike = NonNullable<Change["schedule"]>;

function scheduleProblem(s: ScheduleLike): string | null {
  if ((s.start == null) !== (s.end == null)) return "schedule start and end go together";
  if (s.start != null && (!CLOCK.test(s.start) || !CLOCK.test(s.end!))) return "schedule times must be HH:MM";
  if (s.from != null && !DATE.test(s.from)) return "schedule from must be YYYY-MM-DD";
  if (s.until != null && !DATE.test(s.until)) return "schedule until must be YYYY-MM-DD";
  if (s.from != null && s.until != null && s.from > s.until) return "schedule from is after until";
  if (s.days != null && (s.days.length === 0 || s.days.some((d) => !(DAY_INDEX as readonly string[]).includes(d)))) return "bad schedule days";
  return null;
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Local wall-clock check; an overnight range (22:00-06:00) belongs to the day it starts on.
export function isScheduleActive(schedule: Change["schedule"], now: Date): boolean {
  if (!schedule) return true;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let day = now;
  if (schedule.start != null && schedule.end != null) {
    const s = minutes(schedule.start);
    const e = minutes(schedule.end);
    if (s === e) return false;
    const overnight = s > e;
    if (overnight ? !(nowMin >= s || nowMin < e) : !(nowMin >= s && nowMin < e)) return false;
    if (overnight && nowMin < e) day = new Date(now.getTime() - 86_400_000);
  }
  const date = localDate(day);
  if (schedule.from != null && date < schedule.from) return false;
  if (schedule.until != null && date > schedule.until) return false;
  if (schedule.days != null && !schedule.days.includes(DAY_INDEX[day.getDay()])) return false;
  return true;
}
