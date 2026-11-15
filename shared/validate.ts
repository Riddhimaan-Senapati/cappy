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


const DOM_OPS = new Set(["addLabel", "setAttribute", "removeAttribute", "pauseMedia", "reorder"]);
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

// A named place is one site. "all", "the web", and "this page" are not site names.
const NAMED_SITE = String.raw`(?!all\b|every\b|the\b|this\b|websites?\b|sites?\b|web\b|pages?\b|page\b|internet\b)[\w.-]+`;
const THIS_SITE = String.raw`(?:this|the) (?:site|website)`;
const SITE_WIDE = new RegExp(
  String.raw`\b(?:only (?:on |for )?this (?:site|website)|(?:on |for )?this (?:site|website) only|(?:on|for) this (?:site|website)|every page|whole (?:site|website)|across (?:all of )?${NAMED_SITE}|across ${THIS_SITE}|everywhere on ${NAMED_SITE}|everywhere on ${THIS_SITE}|all over ${NAMED_SITE}|on all of ${NAMED_SITE})\b`,
  "i",
);
const ALL_SITES = /\b(?:all (?:sites|websites)|every (?:site|website)|everywhere)\b/i;
const THIS_PAGE = /\beverywhere on this page\b|\bon this page\b|\bthis page only\b/i;
const PREFERENCE = /\bI (?:prefer|like|hate)\b/i;

// Drop "on this page" before looking for a site or all-sites phrase, so the broader request wins.
function withoutThisPage(message: string): string {
  return message.replace(new RegExp(THIS_PAGE.source, "gi"), " ");
}

export function requestedSiteWide(message: string): boolean {
  return SITE_WIDE.test(message);
}

// "everywhere" and "across all websites" mean every website. "everywhere on youtube" is one site.
// "everywhere on this page" is a one-off, so it is neither.
export function requestedEverywhere(message: string): boolean {
  const rest = withoutThisPage(message);
  return ALL_SITES.test(rest) && !SITE_WIDE.test(rest);
}

export function normalizePagePath(path: string): string {
  const bare = path.split(/[?#]/)[0] || "/";
  const withSlash = bare.startsWith("/") ? bare : `/${bare}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

// Page scope without a stored path is a change made before paths were saved; keep applying it.
export function savedChangeOnThisPage(change: { scope: string; pagePath?: string | null }, pathname: string): boolean {
  if (change.scope !== "page" || !change.pagePath) return true;
  return normalizePagePath(change.pagePath) === normalizePagePath(pathname);
}

export function scopeLabel(scope: string): string {
  if (scope === "everywhere") return "all sites";
  if (scope === "page") return "this page";
  return "this site";
}

// One-off chat edits stay on this page, for a block and for CSS alike. A site-wide or scheduled change is the exception, and the UI names it.
// All-sites is only for an explicit "everywhere" or a stated preference ("I prefer"). The memory prompt is what asks for consent.
export function prepareSavedChange<T extends { scope: string; pagePath?: string | null; schedule?: unknown; block?: { name?: string; itemSelector?: string | null } | null }>(
  change: T,
  message: string,
  trigger: string,
  pathname: string,
): T {
  let scope = change.scope;
  if (trigger === "chat" && (scope === "site" || scope === "everywhere")) {
    const rest = withoutThisPage(message);
    const mentionedPage = THIS_PAGE.test(message);
    const namedSite = requestedSiteWide(rest);
    const siteSpecificFilter = change.block?.name === "contentFilter" && Boolean(change.block.itemSelector);
    // A schedule keeps a portable all-sites filter (no host selector) on every site. A selector is this site only.
    // Saying "on this page" does not shrink a request that also names the site or every site.
    const portableEverywhere = scope === "everywhere" && change.schedule != null && !namedSite && !siteSpecificFilter && !mentionedPage;
    const preferenceEverywhere = scope === "everywhere" && PREFERENCE.test(rest) && !namedSite;
    const everywhere = requestedEverywhere(rest) || preferenceEverywhere || portableEverywhere;
    const siteWide = !everywhere && (namedSite || (!mentionedPage && (change.schedule != null || siteSpecificFilter)));
    scope = everywhere ? "everywhere" : siteWide ? "site" : "page";
  }
  if (scope === "page") return { ...change, scope, pagePath: normalizePagePath(pathname || change.pagePath || "/") };
  return { ...change, scope, pagePath: undefined };
}

// Dark mode looks at the painted page, so it has to run after CSS that may have already darkened it.
export function changesWithDarkModeLast<T extends { block?: { name?: string } | null }>(changes: readonly T[]): T[] {
  return [...changes.filter((change) => change.block?.name !== "darkMode"), ...changes.filter((change) => change.block?.name === "darkMode")];
}

export function validateChange(change: Change): string | null {
  if (change.scope !== "page" && change.scope !== "site" && change.scope !== "everywhere") return "bad scope";
  if (change.pagePath != null && change.pagePath !== "" && (change.pagePath.length > 300 || !change.pagePath.startsWith("/"))) return "bad page path";
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
    if (op.op === "reorder" && op.direction !== "asc" && op.direction !== "desc") return "reorder direction must be asc or desc";
    if (op.op === "reorder" && op.ranking !== null) {
      if (!Array.isArray(op.ranking) || op.ranking.length > 300) return "reorder ranking must be a list of at most 300 items";
      if (op.ranking.some((entry) => typeof entry.key !== "string" || entry.key.length > 300 || !Number.isFinite(entry.rank))) return "each ranking entry needs a key and a numeric rank";
    }
    if (op.op === "reorder" && op.keySelector !== null && typeof op.keySelector !== "string") return "bad reorder keySelector";
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
    if (itemSelector != null && (itemSelector.length > 400 || /[{};@\\<]/.test(itemSelector))) return "filter selector not allowed";
    const { match } = change.block;
    if (match != null && (typeof match !== "string" || match.length > 200)) return "filter match description must be under 200 characters";
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
  if (s.untilAt != null && Number.isNaN(Date.parse(s.untilAt))) return "schedule untilAt must be a datetime";
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
  if (schedule.untilAt != null) {
    const end = Date.parse(schedule.untilAt);
    if (!Number.isNaN(end) && now.getTime() >= end) return false;
  }
  return true;
}

const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const shortDate = (date: string) => {
  const [, month, day] = date.split("-").map(Number);
  return month && day ? `${MONTHS[month - 1]} ${day}` : date;
};

// Plain words for when a scheduled change is on, e.g. "Weekdays 9:00 to 17:00" or "Daily 22:00 to 6:00, until Dec 15".
// "Weekdays 9:00 to 17:00 · on now" or "... · off right now"; null for an always-on change.
export function scheduleStatus(schedule: Change["schedule"], now = new Date()): string | null {
  const text = describeSchedule(schedule);
  return text ? `${text} · ${isScheduleActive(schedule, now) ? "on now" : "off right now"}` : null;
}

// A short span such as "for the next 30 seconds" ends once. Repeating days and clocks are not one-time.
export function isOneShot(schedule: Change["schedule"]): boolean {
  return Boolean(schedule?.untilAt) && !schedule?.days?.length && schedule?.start == null && schedule?.end == null && schedule?.from == null && schedule?.until == null;
}

const SPOKEN_COUNT = String.raw`(?:\d+(?:\.\d+)?|a couple of|a few|forty[- ]five|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|ninety)`;
const SPOKEN_UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)`;
const SPOKEN_SPAN = String.raw`(?:\b(?:for|next)\s+(?:the\s+)?(?:next\s+)?(?:half\s+an?\s+hour|${SPOKEN_COUNT}\s*${SPOKEN_UNIT}(?:\s+and\s+a\s+half)?)\b|\bfor\s+the\s+next\s+(?:hour|minute)\b|\b(?:until|till)\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})(?![\w:]))`;
const SPOKEN_WINDOW = String.raw`\b(?:between|from)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:and|to)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b`;

// "hide podcasts for 30 seconds" becomes "hide podcasts". Null when the message has no counted span.
export function lastingRequest(message: string): string | null {
  const span = new RegExp(SPOKEN_SPAN, "gi");
  if (!span.test(message)) return null;
  const text = message
    .replace(new RegExp(SPOKEN_SPAN, "gi"), " ")
    .replace(new RegExp(SPOKEN_WINDOW, "gi"), " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/^[,\s.;:-]+|[,\s.;:-]+$/g, "")
    .trim();
  if (!text || text.toLowerCase() === message.trim().toLowerCase()) return null;
  return text;
}

export function describeSchedule(schedule: Change["schedule"]): string | null {
  if (!schedule) return null;
  const days = schedule.days ? [...schedule.days].sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b)) : null;
  const key = days?.join(",");
  const dayText = !days || days.length === 7 ? "Daily" : key === "mon,tue,wed,thu,fri" ? "Weekdays" : key === "sat,sun" ? "Weekends" : days.map((day) => DAY_LABEL[day]).join(", ");
  const time = (value: string) => value.replace(/^0(\d):/, "$1:");
  const parts = [schedule.start != null && schedule.end != null ? `${dayText} ${time(schedule.start)} to ${time(schedule.end)}` : days ? dayText : ""];
  if (schedule.from != null && schedule.until != null) parts.push(`${shortDate(schedule.from)} to ${shortDate(schedule.until)}`);
  else if (schedule.from != null) parts.push(`from ${shortDate(schedule.from)}`);
  else if (schedule.until != null) parts.push(`until ${shortDate(schedule.until)}`);
  if (schedule.untilAt != null) {
    const at = new Date(schedule.untilAt);
    if (!Number.isNaN(at.getTime())) parts.push(`until ${time(`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`)}`);
  }
  const text = parts.filter(Boolean).join(", ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}
