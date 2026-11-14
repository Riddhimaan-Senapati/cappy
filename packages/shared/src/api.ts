import { z } from "zod";
import { Adaptation, SnapshotId } from "./adaptation";

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
  })
  .strict();
export type PageOutline = z.infer<typeof PageOutline>;

export const AdaptRequest = z
  .object({ url: z.url({ protocol: /^https?$/ }), outline: PageOutline, profile: Profile })
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

export const ADAPT_PATH = "/adapt";
export const REQUEST_PATH = "/request";
export const VERIFY_PATH = "/verify";
export const LLM_PATH = "/llm";
export const DEFAULT_BACKEND_URL = "http://localhost:8787";
