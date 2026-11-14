import type { Adaptation, BlockConfig, BlockOf } from "@browser-agent/shared";

export type ColorMode = BlockOf<"color_fix">["mode"];

/** CSS for one CSS-expressible block; "" for blocks that need runtime code. */
export function blockCss(_config: BlockConfig): string {
  throw new Error("not implemented");
}

/** Hidden inline SVG holding the color-matrix filter referenced by color_fix CSS. */
export function colorFilterSvg(_mode: ColorMode): string {
  throw new Error("not implemented");
}

/** All CSS for an adaptation: every block's CSS plus the scanned free-form css. */
export function compileAdaptationCss(_adaptation: Adaptation): string {
  throw new Error("not implemented");
}
