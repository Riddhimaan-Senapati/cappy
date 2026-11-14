import { z } from "zod";
import { Adaptation, BlockConfig, ContentFilter, ItemSelector, SnapshotId } from "./adaptation";
import { scanCss } from "./css-scan";
import { Need } from "./profile";

export const ItemGroup = z
  .object({
    selector: ItemSelector,
    count: z.number().int().positive(),
    samples: z.array(z.string().max(100)).max(3),
    label: z.string().max(60).optional(),
    source: z.enum(["adapter", "generic"]).optional(),
  })
  .strict();
export type ItemGroup = z.infer<typeof ItemGroup>;

export const OutlineElement = z
  .object({
    id: SnapshotId,
    tag: z.string().max(20),
    role: z.string().max(40).optional(),
    text: z.string().max(120),
  })
  .strict();
export type OutlineElement = z.infer<typeof OutlineElement>;
import { Profile } from "./profile";

export const PageStats = z
  .object({
    inputsWithoutLabel: z.number().int().nonnegative(),
    smallTargets: z.number().int().nonnegative(),
    smallText: z.number().int().nonnegative(),
    lowContrastText: z.number().int().nonnegative(),
    imagesWithoutAlt: z.number().int().nonnegative(),
    runningAnimations: z.number().int().nonnegative(),
    visibleAdsOrPopups: z.number().int().nonnegative(),
  })
  .strict();
export type PageStats = z.infer<typeof PageStats>;

export const PageOutline = z
  .object({
    title: z.string().max(200),
    headings: z.array(z.string().max(120)).max(30),
    forms: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    videos: z.number().int().nonnegative(),
    canvases: z.number().int().nonnegative(),
    text: z.string().max(6000).optional(),
    elements: z.array(OutlineElement).max(300).optional(),
    stats: PageStats.optional(),
    groups: z.array(ItemGroup).max(20).optional(),
  })
  .strict();
export type PageOutline = z.infer<typeof PageOutline>;

export const ClientTime = z
  .object({ iso: z.string().max(40), timeZone: z.string().max(64) })
  .strict();
export type ClientTime = z.infer<typeof ClientTime>;

export const AdaptRequest = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
    outline: PageOutline,
    profile: Profile,
    clientTime: ClientTime.optional(),
  })
  .strict();
export type AdaptRequest = z.infer<typeof AdaptRequest>;

export const AdaptResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adaptation"), adaptation: Adaptation }).strict(),
  z.object({ kind: z.literal("none"), reason: z.string().max(200) }).strict(),
  z.object({ kind: z.literal("blocked"), reason: z.string().max(200) }).strict(),
]);
export type AdaptResponse = z.infer<typeof AdaptResponse>;

export const ChatRole = z.enum(["system", "user", "assistant"]);
export const LlmRequest = z
  .object({
    messages: z.array(z.object({ role: ChatRole, content: z.string().max(8000) }).strict()).min(1).max(60),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LlmRequest = z.infer<typeof LlmRequest>;
export const LlmResponse = z.object({ text: z.string() }).strict();
export type LlmResponse = z.infer<typeof LlmResponse>;

export const RequestBody = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
    outline: PageOutline,
    profile: Profile,
    request: z.string().min(1).max(500),
    clientTime: ClientTime.optional(),
    retryNote: z.string().max(400).optional(),
  })
  .strict();
export type RequestBody = z.infer<typeof RequestBody>;

export const Screenshot = z.string().startsWith("data:image/").max(4_000_000);

export const VerifyRequest = z
  .object({
    adaptation: Adaptation,
    before: Screenshot,
    after: Screenshot,
    axeBefore: z.number().int().nonnegative(),
    axeAfter: z.number().int().nonnegative(),
    statsBefore: PageStats.optional(),
    statsAfter: PageStats.optional(),
  })
  .strict();
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const Verdict = z.enum(["improved", "no_change", "worse"]);
export type Verdict = z.infer<typeof Verdict>;
export const VerifyResponse = z.object({ verdict: Verdict, notes: z.string().max(300) }).strict();
export type VerifyResponse = z.infer<typeof VerifyResponse>;

export const FrictionKind = z.enum(["zoom_in", "zoom_out", "misclick", "reread", "scroll_back"]);
export type FrictionKind = z.infer<typeof FrictionKind>;
export const FrictionEvent = z
  .object({ kind: FrictionKind, host: z.string().max(253), at: z.number().int().nonnegative() })
  .strict();
export type FrictionEvent = z.infer<typeof FrictionEvent>;

export const INJECTION_BLOCK_REASON = "This page tried to give the agent instructions, so no changes were made.";

// A saved preference compiled once into a change that is safe to apply on any site with no model call.
// Filters carry no itemSelector so they target whatever repeated items each site has.
export const GlobalChange = z
  .object({
    css: z.string().max(6000).optional(),
    blocks: z.array(BlockConfig).max(6),
    filters: z.array(ContentFilter).max(6),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!c.css && c.blocks.length === 0 && c.filters.length === 0) {
      ctx.addIssue({ code: "custom", message: "change does nothing" });
    }
    if (c.css) {
      const scan = scanCss(c.css);
      if (!scan.ok) ctx.addIssue({ code: "custom", path: ["css"], message: scan.reason });
    }
    c.filters.forEach((f, i) => {
      if (f.itemSelector !== undefined) {
        ctx.addIssue({ code: "custom", path: ["filters", i, "itemSelector"], message: "global filters cannot name a site selector" });
      }
    });
    const names = c.blocks.map((b) => b.block);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", path: ["blocks"], message: "each block may appear once" });
  });
export type GlobalChange = z.infer<typeof GlobalChange>;

export const CompilePreferenceRequest = z
  .object({ need: Need, clientTime: ClientTime.optional() })
  .strict();
export type CompilePreferenceRequest = z.infer<typeof CompilePreferenceRequest>;

export const CompilePreferenceResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compiled"), change: GlobalChange, summary: z.string().min(1).max(160) }).strict(),
  z.object({ kind: z.literal("none"), reason: z.string().max(200) }).strict(),
]);
export type CompilePreferenceResponse = z.infer<typeof CompilePreferenceResponse>;

export const COMPILE_PREFERENCE_PATH = "/compile-preference";
export const ADAPT_PATH = "/adapt";
export const REQUEST_PATH = "/request";
export const VERIFY_PATH = "/verify";
export const LLM_PATH = "/llm";
export const DEFAULT_BACKEND_URL = "http://localhost:8787";
