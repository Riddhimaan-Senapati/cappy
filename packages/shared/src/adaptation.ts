import { z } from "zod";
import { scanCss } from "./css-scan";
import { NeedId } from "./profile";
import { Schedule } from "./schedule";

export const HostPattern = z
  .string()
  .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/, "host or *.host, lowercase, no scheme or path")
  .brand<"HostPattern">();
export type HostPattern = z.infer<typeof HostPattern>;

export const Selector = z.string().min(1).max(200);

export const TextFocus = z
  .object({
    block: z.literal("text_focus"),
    fontScale: z.number().min(1).max(2.5),
    lineHeight: z.number().min(1).max(2.5),
    font: z.enum(["system", "atkinson", "opendyslexic"]),
    hide: z.array(Selector).max(30),
  })
  .strict();

export const ColorFix = z
  .object({
    block: z.literal("color_fix"),
    mode: z.enum(["protanopia", "deuteranopia", "tritanopia"]),
    targets: z.array(z.enum(["images", "video", "canvas", "svg"])).min(1),
  })
  .strict();

export const FormFixer = z
  .object({
    block: z.literal("form_fixer"),
    addLabels: z.boolean(),
    clearErrors: z.boolean(),
    minTargetPx: z.number().int().min(24).max(64),
    oneQuestionMode: z.boolean(),
  })
  .strict();

export const GestureScroll = z
  .object({
    block: z.literal("gesture_scroll"),
    scrollStepPx: z.number().int().min(50).max(1000),
    backGesture: z.boolean(),
  })
  .strict();

export const StopMotion = z
  .object({
    block: z.literal("stop_motion"),
    pauseMedia: z.boolean(),
  })
  .strict();

export const TextScale = z
  .object({
    block: z.literal("text_scale"),
    scale: z.number().min(1).max(2),
  })
  .strict();

export const BlockConfig = z.discriminatedUnion("block", [
  TextFocus,
  ColorFix,
  FormFixer,
  GestureScroll,
  StopMotion,
  TextScale,
]);
export type BlockConfig = z.infer<typeof BlockConfig>;
export type BlockName = BlockConfig["block"];
export type BlockOf<N extends BlockName> = Extract<BlockConfig, { block: N }>;

export const SnapshotId = z.string().regex(/^n\d{1,4}$/, "snapshot id like n12").brand<"SnapshotId">();
export type SnapshotId = z.infer<typeof SnapshotId>;

export const STYLE_PROPERTIES = [
  "color", "background-color", "font-size", "font-family", "font-weight", "line-height", "letter-spacing",
  "text-align", "text-decoration", "display", "visibility", "opacity", "filter", "max-width", "width",
  "min-height", "padding", "margin", "gap", "border", "border-radius", "outline", "order",
] as const;

export const SnapshotOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("hide"), ids: z.array(SnapshotId).min(1).max(50) }).strict(),
  z
    .object({
      op: z.literal("style"),
      ids: z.array(SnapshotId).min(1).max(50),
      styles: z.partialRecord(z.enum(STYLE_PROPERTIES), z.string().max(120)),
    })
    .strict(),
]);
export type SnapshotOp = z.infer<typeof SnapshotOp>;

export const ItemSelector = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^{};@\\<]+$/, "a plain CSS selector");

export const ContentFilter = z
  .object({
    itemSelector: ItemSelector.optional(),
    keywords: z.array(z.string().trim().min(2).max(40)).min(1).max(12),
    action: z.enum(["hide", "dim"]),
    schedule: Schedule.optional(),
    everywhere: z.boolean().optional(),
  })
  .strict();
export type ContentFilter = z.infer<typeof ContentFilter>;

export const AdaptationId = z.string().min(1).max(64).brand<"AdaptationId">();
export type AdaptationId = z.infer<typeof AdaptationId>;

export const Adaptation = z
  .object({
    id: AdaptationId,
    sites: z.array(HostPattern).min(1).max(10),
    reason: z.object({ text: z.string().min(1).max(160), needId: NeedId }).strict(),
    blocks: z.array(BlockConfig).max(6),
    css: z.string().max(6000).optional(),
    ops: z.array(SnapshotOp).max(20).optional(),
    filters: z.array(ContentFilter).max(6).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const names = a.blocks.map((b) => b.block);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["blocks"], message: "each block may appear once" });
    }
    if (a.blocks.length === 0 && !a.css && !a.ops?.length && !a.filters?.length) {
      ctx.addIssue({ code: "custom", path: ["blocks"], message: "adaptation changes nothing" });
    }
    if (a.css) {
      const scan = scanCss(a.css);
      if (!scan.ok) ctx.addIssue({ code: "custom", path: ["css"], message: scan.reason });
    }
    a.ops?.forEach((op, i) => {
      if (op.op !== "style") return;
      for (const [prop, value] of Object.entries(op.styles)) {
        const scan = scanCss(`${prop}: ${value}`);
        if (!scan.ok || /[;{}]/.test(value ?? "")) {
          ctx.addIssue({ code: "custom", path: ["ops", i, "styles", prop], message: scan.ok ? "style value must be one value" : scan.reason });
        }
      }
    });
  });
export type Adaptation = z.infer<typeof Adaptation>;

export function matchesHost(pattern: HostPattern, host: string): boolean {
  const h = host.toLowerCase();
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === pattern;
}

export function opsTargetKnownIds(adaptation: Adaptation, known: ReadonlySet<string>): boolean {
  return (adaptation.ops ?? []).every((op) => op.ids.every((id) => known.has(id)));
}

export function filtersTargetKnownGroups(adaptation: Adaptation, known: ReadonlySet<string>): boolean {
  return (adaptation.filters ?? []).every((f) => f.itemSelector === undefined || known.has(f.itemSelector));
}

export const RuleId = z.string().min(1).max(64).brand<"RuleId">();
export type RuleId = z.infer<typeof RuleId>;

// A standing content rule: replayed on every matching page with no model call, gated by its schedule.
export const Rule = z
  .object({
    id: RuleId,
    text: z.string().min(1).max(200),
    sites: z.array(HostPattern).max(20),
    everywhere: z.boolean(),
    filter: ContentFilter,
    enabled: z.boolean(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type Rule = z.infer<typeof Rule>;

export function ruleAppliesTo(rule: Rule, host: string): boolean {
  return rule.enabled && (rule.everywhere || rule.sites.some((p) => matchesHost(p, host)));
}
