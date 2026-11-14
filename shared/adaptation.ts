import { z } from "zod";
import { REMOVABLE_ATTRIBUTES, SAFE_ATTRIBUTES } from "./validate.js";

export { LIMITS, scanCss, validateChange } from "./validate.js";

export const BLOCK_NAMES = ["colorblind", "textScale", "stopMotion"] as const;
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
]);

export const Change = z.object({
  id: z.string().describe("Short kebab-case id, stable for the same intent (e.g. 'invert-page'). Reusing an id replaces that change."),
  summary: z.string().describe("What this change does, in a few words, shown to the user."),
  reason: z.string().describe("One sentence citing the profile line or request that caused it."),
  css: z.string().nullable().describe("CSS you write to implement the change. No url(), @import, or content strings."),
  dom: z.array(DomOp).nullable().describe("Allowed DOM operations for what CSS cannot do."),
  block: BlockCall.nullable().describe("A pre-built capability for what neither CSS nor DOM ops can do."),
  scope: z.enum(["site", "everywhere"]).describe("site = only this website; everywhere = every site the user visits (only when the user asks for it or the need is clearly universal)."),
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
  targetLabel?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}
