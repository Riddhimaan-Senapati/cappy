import { scanCss, type Adaptation, type BlockConfig, type BlockOf } from "@browser-agent/shared";

export type ColorMode = BlockOf<"color_fix">["mode"];

const FONT_FAMILY: Record<BlockOf<"text_focus">["font"], string> = {
  atkinson: `"Atkinson Hyperlegible", system-ui, sans-serif`,
  opendyslexic: `"OpenDyslexic", "Comic Sans MS", system-ui, sans-serif`,
  system: `system-ui, sans-serif`,
};

const COLOR_TARGETS: Record<BlockOf<"color_fix">["targets"][number], readonly string[]> = {
  images: ["img", "picture img"],
  video: ["video"],
  canvas: ["canvas"],
  svg: ["svg"],
};

// Rejects selectors that could close the rule, open a new one, or carry at-rules and escapes.
// A trailing ">" is rejected because it cannot be a valid combinator at the end of a selector.
const UNSAFE_SELECTOR = /[{};@\\<]|>\s*$/;

const CVD_MATRICES: Record<ColorMode, readonly number[]> = {
  protanopia: [1, 0, 0, 0, 0, 0.478897, 0.476911, 0.044192, 0, 0, 0.597282, -0.688692, 1.09141, 0, 0, 0, 0, 0, 1, 0],
  deuteranopia: [1.436619, -0.631397, 0.194779, 0, 0, 0, 1, 0, 0, 0, -0.184239, 0.186309, 0.99793, 0, 0, 0, 0, 0, 1, 0],
  tritanopia: [0.741159, -0.407208, 0.666049, 0, 0, 0.075098, 0.585234, 0.339668, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
};

function rule(selectors: readonly string[], declarations: string): string {
  return `${selectors.join(", ")} { ${declarations} }`;
}

function textFocusCss(config: BlockOf<"text_focus">): string {
  const hidden = config.hide
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !UNSAFE_SELECTOR.test(s))
    .map((s) => rule([s], "display: none !important;"));
  return [
    `html { font-size: ${Math.round(config.fontScale * 100)}% !important; }`,
    rule(["body", "p", "li", "td", "dd", "label"], `line-height: ${config.lineHeight} !important;`),
    rule(["body", "body *"], `font-family: ${FONT_FAMILY[config.font]} !important;`),
    ...hidden,
  ].join("\n");
}

function colorFixCss(config: BlockOf<"color_fix">): string {
  const selectors = [...new Set(config.targets.flatMap((t) => COLOR_TARGETS[t]))];
  return rule(selectors, `filter: url(#ba-cvd-${config.mode}) !important;`);
}

function formFixerCss(config: BlockOf<"form_fixer">): string {
  const controlSize = Math.round(config.minTargetPx * 0.6);
  return [
    rule(
      ["input", "select", "textarea", "button", "a", "[role=button]"],
      `min-height: ${config.minTargetPx}px !important;`,
    ),
    rule(
      ["input[type=checkbox]", "input[type=radio]"],
      `width: ${controlSize}px !important; height: ${controlSize}px !important;`,
    ),
    rule([":focus-visible"], "outline: 3px solid #1a73e8 !important; outline-offset: 2px !important;"),
  ].join("\n");
}

/** CSS for one CSS-expressible block; "" for blocks that need runtime code. */
export function blockCss(config: BlockConfig): string {
  switch (config.block) {
    case "text_focus":
      return textFocusCss(config);
    case "color_fix":
      return colorFixCss(config);
    case "form_fixer":
      return formFixerCss(config);
    case "gesture_scroll":
    case "text_scale":
      return "";
    case "stop_motion":
      return [
        "*, *::before, *::after { animation-play-state: paused !important; animation-iteration-count: 1 !important; transition: none !important; scroll-behavior: auto !important; }",
        "marquee { display: none !important; }",
      ].join("\n");
    default: {
      const unreachable: never = config;
      throw new Error(`unknown block: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Hidden inline SVG holding the color-matrix filter referenced by color_fix CSS. */
export function colorFilterSvg(mode: ColorMode): string {
  const values = CVD_MATRICES[mode].join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden" data-ba-cvd><defs><filter id="ba-cvd-${mode}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${values}"/></filter></defs></svg>`;
}

/** All CSS for an adaptation: every block's CSS plus the scanned free-form css. */
export function compileAdaptationCss(adaptation: Adaptation): string {
  const parts = adaptation.blocks.map(blockCss).filter((css) => css.length > 0);
  if (adaptation.css && scanCss(adaptation.css).ok) parts.push(adaptation.css);
  return parts.join("\n");
}
