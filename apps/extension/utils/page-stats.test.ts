import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

if (!globalThis.document) GlobalRegistrator.register();

const { computePageStats, contrastRatio, effectiveBackground, hasAccessibleName, over, parseColor } = await import("./page-stats");

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const el = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
};

test("black on white is the maximum contrast ratio", () => {
  expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
  expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
  expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
});

test("gray text passes or fails 4.5:1 at the known WCAG boundary", () => {
  expect(contrastRatio({ r: 0x76, g: 0x76, b: 0x76, a: 1 }, WHITE)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio({ r: 0x77, g: 0x77, b: 0x77, a: 1 }, WHITE)).toBeLessThan(4.5);
});

test("parses rgb, rgba, percentage and space-separated forms", () => {
  expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  expect(parseColor("rgb(100%, 0%, 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  expect(parseColor("transparent")?.a).toBe(0);
});

test("returns undefined for color formats it does not parse", () => {
  expect(parseColor("oklch(0.5 0.1 200)")).toBeUndefined();
  expect(parseColor("not a color")).toBeUndefined();
});

test("translucent text is composited over the background before comparing", () => {
  expect(over({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
});

test("nearest opaque ancestor background wins, with white as the default", () => {
  document.body.innerHTML = '<div style="background-color: rgb(1, 2, 3)"><p><span id="s">x</span></p></div>';
  const span = document.getElementById("s")!;
  expect(effectiveBackground(span, window)).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  document.body.innerHTML = '<p id="p">x</p>';
  expect(effectiveBackground(document.getElementById("p")!, window)).toEqual(WHITE);
});

test("input with a for-label, a wrapping label, or aria/title has an accessible name", () => {
  document.body.innerHTML = '<label for="a">Email</label><input id="a"><label>Name <input id="b"></label>';
  expect(hasAccessibleName(document.getElementById("a")!)).toBe(true);
  expect(hasAccessibleName(document.getElementById("b")!)).toBe(true);
  expect(hasAccessibleName(el('<input aria-label="Search">'))).toBe(true);
  expect(hasAccessibleName(el('<input title="Zip">'))).toBe(true);
  expect(hasAccessibleName(el('<input aria-labelledby="x">'))).toBe(true);
});

test("a placeholder alone does not name an input", () => {
  expect(hasAccessibleName(el('<input placeholder="Search">'))).toBe(false);
});

test("a label that points at another id does not name the input", () => {
  document.body.innerHTML = '<label for="other">Email</label><input id="a">';
  expect(hasAccessibleName(document.getElementById("a")!)).toBe(false);
});

test("computePageStats runs on a document without layout and returns every key", () => {
  document.body.innerHTML = '<img src="a.png"><input><p style="color: #777">faint</p>';
  const stats = computePageStats(document);
  expect(Object.keys(stats).sort()).toEqual(
    ["imagesWithoutAlt", "inputsWithoutLabel", "lowContrastText", "runningAnimations", "smallTargets", "smallText", "visibleAdsOrPopups"].sort(),
  );
  for (const value of Object.values(stats)) expect(Number.isInteger(value) && value >= 0).toBe(true);
});
