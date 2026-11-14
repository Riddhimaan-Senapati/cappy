import { z } from "zod";
import { REMOVABLE_ATTRIBUTES, SAFE_ATTRIBUTES } from "./validate.js";

export { LIMITS, scanCss, validateChange } from "./validate.js";

export const BLOCK_NAMES = ["colorblind", "textScale", "stopMotion", "darkMode", "contentFilter", "formFixer"] as const;
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
  z.object({
    op: z.literal("reorder"),
    selector: z.string().describe("Selector for the items to sort, e.g. the video tiles. Items are sorted within their own parent."),
    keySelector: z.string().nullable().describe("Selector inside each item whose text identifies it (e.g. the title). null = the item's own text."),
    direction: z.enum(["asc", "desc"]).describe("Only for alphabetical sorting (ranking null). Ignored when ranking is given."),
    ranking: z
      .array(z.object({ key: z.string().describe("The item's key text exactly as list_items returned it."), rank: z.number().describe("Position in the final order: 1 is shown first.") }))
      .nullable()
      .describe("Your own ranking for any criterion (views, date, price, relevance), worked out from list_items. null = alphabetical by key text, which also keeps sorting items that load later."),
  }),
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
    allowSiteControls: z.boolean().describe("Legacy compatibility flag. Set false. Use find_site_features and use_site_control for native theme controls."),
  }),
  z.object({
    name: z.literal("formFixer"),
    minTargetPx: z.number().describe("Minimum width and height in pixels for form controls, from 24 to 64."),
    addLabels: z.boolean().describe("Add visible labels to unnamed form controls when the page supplies enough information."),
    clearErrors: z.boolean().describe("Show readable inline explanations for native validation errors."),
    oneQuestionMode: z.boolean().describe("Show one field at a time on simple forms. Enable only when requested."),
  }),
  z.object({
    name: z.literal("contentFilter"),
    keywords: z.array(z.string()).describe("Words that appear in the items to hide (text, aria-label or link URL); include singular and plural."),
    itemSelector: z.string().nullable().describe("Selector of the repeated item card from the page outline's itemGroups, or null to apply to every repeated item group on any site."),
    action: z.enum(["hide", "dim"]),
  }),
]);

export const Schedule = z.object({
  days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).nullish().describe("Days the change is active (weekdays = mon to fri). Omit when the user did not state days."),
  start: z.string().nullish().describe("Local start time HH:MM (24h). Set together with end. Omit when no time of day was stated."),
  end: z.string().nullish().describe("Local end time HH:MM (24h). Overnight ranges like 22:00 to 06:00 are allowed. Omit when no time of day was stated."),
  from: z.string().nullish().describe("First active local date YYYY-MM-DD, inclusive. Omit when no start date was stated."),
  until: z.string().nullish().describe("Last active local date YYYY-MM-DD, inclusive. Omit when no end date was stated."),
  untilAt: z.string().nullish().describe("ISO datetime when a short span ends, such as 'for the next 30 seconds'. The change turns off at this instant. Omit for rules that repeat by day or clock."),
});
export type Schedule = z.infer<typeof Schedule>;

export const Change = z.object({
  id: z.string().describe("Short kebab-case id, stable for the same intent (e.g. 'invert-page'). Reusing an id replaces that change."),
  summary: z.string().describe("What this change does, in a few words, shown to the user."),
  reason: z.string().describe("One sentence citing the profile line or request that caused it."),
  css: z.string().nullable().describe("CSS you write to implement the change. No url(), @import, or content strings."),
  dom: z.array(DomOp).nullable().describe("Allowed DOM operations for what CSS cannot do."),
  block: BlockCall.nullable().describe("A pre-built capability for what neither CSS nor DOM ops can do."),
  scope: z.enum(["site", "everywhere"]).describe("site = only this website, including site-specific implementations of global preferences; everywhere = portable implementations of cross-site preferences."),
  schedule: Schedule.nullable().optional().describe("Only for time-limited requests (e.g. weekdays 9-5, until Dec 15); null means always."),
});

export type DomOp = z.infer<typeof DomOp>;
export type BlockCall = z.infer<typeof BlockCall>;
export type Change = z.infer<typeof Change>;

export interface ItemGroup {
  selector: string;
  count: number;
  samples: string[];
  label?: string;
}

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
  itemGroups: ItemGroup[];
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
  targetLabel?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}
