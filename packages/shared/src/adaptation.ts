import { z } from "zod";
import { scanCss } from "./css-scan";
import { NeedId } from "./profile";

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

export const BlockConfig = z.discriminatedUnion("block", [TextFocus, ColorFix, FormFixer, GestureScroll]);
export type BlockConfig = z.infer<typeof BlockConfig>;
export type BlockName = BlockConfig["block"];
export type BlockOf<N extends BlockName> = Extract<BlockConfig, { block: N }>;

export const AdaptationId = z.string().min(1).max(64).brand<"AdaptationId">();
export type AdaptationId = z.infer<typeof AdaptationId>;

export const Adaptation = z
  .object({
    id: AdaptationId,
    sites: z.array(HostPattern).min(1).max(10),
    reason: z.object({ text: z.string().min(1).max(160), needId: NeedId }).strict(),
    blocks: z.array(BlockConfig).max(4),
    css: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const names = a.blocks.map((b) => b.block);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["blocks"], message: "each block may appear once" });
    }
    if (a.blocks.length === 0 && !a.css) {
      ctx.addIssue({ code: "custom", path: ["blocks"], message: "adaptation changes nothing" });
    }
    if (a.css) {
      const scan = scanCss(a.css);
      if (!scan.ok) ctx.addIssue({ code: "custom", path: ["css"], message: scan.reason });
    }
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
