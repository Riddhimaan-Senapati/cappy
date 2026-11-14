import { describe, expect, test } from "bun:test";
import type { Adaptation, BlockConfig } from "@browser-agent/shared";
import { blockCss, colorFilterSvg, compileAdaptationCss, type ColorMode } from "./index";

const textFocus = (overrides: Partial<Extract<BlockConfig, { block: "text_focus" }>> = {}): BlockConfig => ({
  block: "text_focus",
  fontScale: 1.5,
  lineHeight: 1.8,
  font: "atkinson",
  hide: [],
  ...overrides,
});

const adaptation = (overrides: Partial<Adaptation>): Adaptation =>
  ({
    id: "a1",
    sites: ["example.com"],
    reason: { text: "reduce clutter", needId: "low_vision" },
    blocks: [],
    ...overrides,
  }) as Adaptation;

describe("blockCss text_focus", () => {
  test("scales font size, line height, and applies the font family", () => {
    const css = blockCss(textFocus());
    expect(css).toContain("html { font-size: 150% !important; }");
    expect(css).toContain("line-height: 1.8 !important;");
    expect(css).toContain(`font-family: "Atkinson Hyperlegible", system-ui, sans-serif !important;`);
  });

  test("uses the OpenDyslexic and system font stacks", () => {
    expect(blockCss(textFocus({ font: "opendyslexic" }))).toContain(`"OpenDyslexic", "Comic Sans MS"`);
    expect(blockCss(textFocus({ font: "system" }))).toContain("font-family: system-ui, sans-serif !important;");
  });

  test("emits display none rules for hide selectors, keeping child combinators", () => {
    const css = blockCss(textFocus({ hide: [".ad", "main > aside"] }));
    expect(css).toContain(".ad { display: none !important; }");
    expect(css).toContain("main > aside { display: none !important; }");
  });

  test("skips hide selectors that attempt CSS injection", () => {
    const css = blockCss(textFocus({ hide: ["a{} body{background:red", ".ok", "a>", "x@import", "b\\7b"] }));
    expect(css).not.toContain("background:red");
    expect(css).not.toContain("@import");
    expect(css).toContain(".ok { display: none !important; }");
    expect(css).not.toContain("a> {");
    expect(css).not.toContain("b\\7b");
  });
});

describe("blockCss color_fix", () => {
  test("references the matching filter id on mapped targets", () => {
    const css = blockCss({ block: "color_fix", mode: "deuteranopia", targets: ["images", "svg"] });
    expect(css).toContain("img, picture img, svg { filter: url(#ba-cvd-deuteranopia) !important; }");
  });

  test("deduplicates selectors across targets", () => {
    const css = blockCss({ block: "color_fix", mode: "tritanopia", targets: ["images", "images", "video"] });
    expect(css).toBe("img, picture img, video { filter: url(#ba-cvd-tritanopia) !important; }");
  });
});

describe("blockCss form_fixer", () => {
  test("sets target size, checkbox scaling, and focus outline", () => {
    const css = blockCss({
      block: "form_fixer",
      addLabels: true,
      clearErrors: true,
      minTargetPx: 44,
      oneQuestionMode: false,
    });
    expect(css).toContain("min-height: 44px !important;");
    expect(css).toContain("input[type=checkbox], input[type=radio]");
    expect(css).toContain("width: 26px !important; height: 26px !important;");
    expect(css).toContain(":focus-visible { outline: 3px solid #1a73e8 !important; outline-offset: 2px !important; }");
  });
});

describe("blockCss gesture_scroll", () => {
  test("is a runtime block with no CSS", () => {
    expect(blockCss({ block: "gesture_scroll", scrollStepPx: 300, backGesture: true })).toBe("");
  });
});

describe("colorFilterSvg", () => {
  const modes: ColorMode[] = ["protanopia", "deuteranopia", "tritanopia"];

  test.each(modes)("%s has a 20-value matrix and the matching filter id", (mode) => {
    const svg = colorFilterSvg(mode);
    const values = svg.match(/values="([^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(values).toHaveLength(20);
    expect(values.every((v) => Number.isFinite(Number(v)))).toBe(true);
    expect(svg).toContain(`<filter id="ba-cvd-${mode}"`);
    expect(svg).toContain('color-interpolation-filters="linearRGB"');
    expect(svg).toContain("data-ba-cvd");
  });
});

describe("compileAdaptationCss", () => {
  test("joins block CSS and appends safe free-form css", () => {
    const css = compileAdaptationCss(
      adaptation({
        blocks: [textFocus({ hide: [".ad"] }), { block: "gesture_scroll", scrollStepPx: 300, backGesture: false }],
        css: ".banner { color: red; }",
      }),
    );
    expect(css).toContain("html { font-size: 150% !important; }");
    expect(css).toContain(".ad { display: none !important; }");
    expect(css.endsWith(".banner { color: red; }")).toBe(true);
    expect(css.split("\n").some((line) => line.length === 0)).toBe(false);
  });

  test("drops free-form css that contains url()", () => {
    const css = compileAdaptationCss(
      adaptation({ blocks: [textFocus()], css: "body { background: url(https://evil.test/x.png); }" }),
    );
    expect(css).not.toContain("url(");
    expect(css).not.toContain("evil.test");
  });

  test("returns an empty string when only runtime blocks are present", () => {
    expect(
      compileAdaptationCss(adaptation({ blocks: [{ block: "gesture_scroll", scrollStepPx: 300, backGesture: true }] })),
    ).toBe("");
  });
});

test("stop_motion pauses animations and transitions; text_scale is runtime-only", () => {
  const css = blockCss({ block: "stop_motion", pauseMedia: true });
  expect(css).toContain("animation-play-state: paused");
  expect(css).toContain("transition: none");
  expect(blockCss({ block: "text_scale", scale: 1.4 })).toBe("");
});
