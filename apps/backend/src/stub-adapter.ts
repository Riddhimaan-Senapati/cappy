import { randomUUID } from "node:crypto";
import {
  AdaptationId,
  HostPattern,
  NeedId,
  type Adaptation,
  type AdaptRequest,
  type AdaptResponse,
  type BlockConfig,
  type BlockOf,
  type Need,
} from "@browser-agent/shared";
import type { Adapter } from "./adapter";

const HIDE_SIDEBARS = ["aside", "[role=complementary]"];
const ALL_COLOR_TARGETS: BlockOf<"color_fix">["targets"] = ["images", "video", "canvas", "svg"];
const REASON_MAX = 160;

export function colorModeFor(detail: string): BlockOf<"color_fix">["mode"] {
  const text = detail.toLowerCase();
  if (text.includes("protan")) return "protanopia";
  if (text.includes("tritan")) return "tritanopia";
  return "deuteranopia";
}

function textFocusFor(needs: Need[]): BlockOf<"text_focus"> | undefined {
  const wantsLargerText = needs.some((n) => n.kind === "text_size");
  const wantsFocus = needs.some((n) => n.kind === "focus");
  if (!wantsLargerText && !wantsFocus) return undefined;
  return {
    block: "text_focus",
    fontScale: wantsLargerText ? 1.25 : 1,
    lineHeight: wantsLargerText ? 1.6 : 1,
    font: wantsLargerText ? "atkinson" : "system",
    hide: wantsFocus ? [...HIDE_SIDEBARS] : [],
  };
}

export function blocksFor(needs: Need[]): BlockConfig[] {
  const blocks: BlockConfig[] = [];
  const text = textFocusFor(needs);
  if (text) blocks.push(text);
  const color = needs.find((n) => n.kind === "color_vision");
  if (color) {
    blocks.push({ block: "color_fix", mode: colorModeFor(color.detail), targets: ALL_COLOR_TARGETS });
  }
  if (needs.some((n) => n.kind === "motor")) {
    blocks.push({ block: "form_fixer", addLabels: true, clearErrors: true, minTargetPx: 44, oneQuestionMode: false });
  }
  return blocks;
}

export function adaptationFor(req: AdaptRequest, blocks: BlockConfig[]): Adaptation {
  const [first] = req.profile.needs;
  if (!first) throw new Error("adaptationFor requires at least one need");
  return {
    id: AdaptationId.parse(randomUUID()),
    sites: [HostPattern.parse(new URL(req.url).hostname)],
    reason: { text: first.detail.slice(0, REASON_MAX), needId: NeedId.parse(first.id) },
    blocks,
  };
}

export const stubAdapter: Adapter = async (req): Promise<AdaptResponse> => {
  const { needs } = req.profile;
  if (needs.length === 0) return { kind: "none", reason: "no needs in profile" };
  const blocks = blocksFor(needs);
  if (blocks.length === 0) return { kind: "none", reason: "no building block covers these needs" };
  return { kind: "adaptation", adaptation: adaptationFor(req, blocks) };
};
