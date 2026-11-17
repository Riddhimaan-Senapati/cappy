import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { contrastInfo } from "../extension/src/content/dom.js";
import { parseRgba, relativeLuminance } from "../extension/src/content/dark-mode.js";

if (!globalThis.document) GlobalRegistrator.register();

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});

describe("percent alpha in page colors", () => {
  it("parses rgb with a slash and percent alpha", () => {
    assert.equal(parseRgba("rgb(0 0 0 / 50%)")?.a, 0.5);
    assert.equal(parseRgba("rgba(255, 0, 0, 50%)")?.a, 0.5);
  });

  it("composites a 50% black background over the white default", () => {
    document.body.innerHTML = '<p id="t">Hello there</p>';
    const p = document.getElementById("t")!;
    p.setAttribute("style", "background-color: rgba(0, 0, 0, 50%); color: rgb(0, 0, 0)");
    const info = contrastInfo(p);
    assert.ok(Number.isFinite(info.ratio), `ratio should be finite, got ${info.ratio}`);
    assert.equal(info.background, "#808080");
  });
});

describe("relative luminance", () => {
  it("keeps the same numbers for black, white and mid gray", () => {
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
    assert.ok(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }) - 1) < 1e-9);
    assert.ok(Math.abs(relativeLuminance({ r: 128, g: 128, b: 128, a: 1 }) - 0.21586050011389926) < 1e-9);
  });
});
