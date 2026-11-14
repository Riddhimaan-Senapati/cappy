import { z } from "zod";
import { REMOVABLE_ATTRIBUTES, SAFE_ATTRIBUTES } from "./validate.js";

export { LIMITS, scanCss, validateChange } from "./validate.js";

export const BLOCK_NAMES = ["colorblind", "textScale", "stopMotion", "darkMode", "contentFilter"] as const;
export type BlockName = (typeof BLOCK_NAMES)[number];

// Schemas avoid min/max keywords so they map cleanly onto LLM structured-output formats; limits are enforced in validateChange.
const selector = z.string().describe("A CSS selector for elements on this page, based on the page outline.");

export const DomOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addLabel"),
    selector,
    text: z.string().describe("Visible label text, inserted as plain text before each matched form control."),
  }),
  z.object({ op: z.literal("setAttribute"), selector, name: z.enum(SAFE_ATTRIBUTES), value: z.string() }),
  z.object({ op: z.literal("removeAttribute"), selector, name: z.enum(REMOVABLE_ATTRIBUTES) }),
  z.object({ op: z.literal("pauseMedia"), selector }),
]);

export const BlockCall = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("colorblind"),
    type: z.enum(["protanopia", "deuteranopia", "tritanopia"]),
    scope: z.enum(["media", "page"]).describe("media = img, video, canvas, svg only; page = everything"),
  }),
  z.object({
    name: z.literal("textScale"),
    scale: z.number().describe("Multiplier for every text element's computed size, 1.0 to 2.0. Works on px-based sites where CSS rem/% tricks fail."),
  }),
  z.object({ name: z.literal("stopMotion") }),
  z.object({
    name: z.literal("darkMode"),
    allowSiteControls: z.boolean().describe("true lets it click the site's own dark mode toggle when the site has one."),
  }),
  z.object({
    name: z.literal("contentFilter"),
    keywords: z.array(z.string()).describe("Words that appear in the items to hide (text, aria-label or link URL); include singular and plural."),
    itemSelector: z.string().nullable().describe("Selector of the repeated item card from the page outline's itemGroups, or null to apply to every repeated item group on any site."),
    action: z.enum(["hide", "dim"]),
  }),
]);

export const Schedule = z.object({
  days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).nullable().describe("Days the change is active, or null for every day."),
  start: z.string().nullable().describe("Local start time HH:MM (24h), or null."),
  end: z.string().nullable().describe("Local end time HH:MM (24h), or null. Overnight ranges like 22:00-06:00 are allowed."),
  from: z.string().nullable().describe("First active date YYYY-MM-DD, or null."),
  until: z.string().nullable().describe("Last active date YYYY-MM-DD inclusive, or null."),
});
export type Schedule = z.infer<typeof Schedule>;

export const Change = z.object({
  id: z.string().describe("Short kebab-case id, stable for the same intent (e.g. 'invert-page'). Reusing an id replaces that change."),
  summary: z.string().describe("What this change does, in a few words, shown to the user."),
  reason: z.string().describe("One sentence citing the profile line or request that caused it."),
  css: z.string().nullable().describe("CSS you write to implement the change. No url(), @import, or content strings."),
  dom: z.array(DomOp).nullable().describe("Allowed DOM operations for what CSS cannot do."),
  block: BlockCall.nullable().describe("A pre-built capability for what neither CSS nor DOM ops can do."),
  scope: z.enum(["site", "everywhere"]).describe("site = only this website; everywhere = every site the user visits (only when the user asks for it or the need is clearly universal)."),
  schedule: Schedule.nullable().optional().describe("Only for time-limited requests (e.g. weekdays 9-5, until Dec 15); null means always."),
});

export type DomOp = z.infer<typeof DomOp>;
export type BlockCall = z.infer<typeof BlockCall>;
export type Change = z.infer<typeof Change>;

export interface OutlineElement {
  selector: string;
  tag: string;
  role?: string;
  text?: string;
  note?: string;
}

export interface PageOutline {
  url: string;
  title: string;
  headings: string[];
  elements: OutlineElement[];
  stats: PageStats;
  styleHints: { background: string; color: string; fontSizePx: number; fontFamily: string };
  textSample: string;
}

export interface PageStats {
  inputsWithoutLabel: number;
  smallTargets: number;
  smallText: number;
  lowContrastText: number;
  imagesWithoutAlt: number;
  runningAnimations: number;
  visibleAdsOrPopups: number;
}

export interface ActiveChange extends Change {
  appliedAt: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}
