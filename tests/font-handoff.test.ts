import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Change } from "../shared/adaptation.js";
import { installDom } from "./dom-setup.js";

const dom = installDom();
Object.assign(globalThis, { CSSStyleSheet: dom.CSSStyleSheet, CSSStyleRule: dom.CSSStyleRule });
if (typeof document.getAnimations !== "function") {
  Object.defineProperty(document, "getAnimations", { value: () => [], configurable: true });
}
if (typeof matchMedia !== "function") {
  Object.defineProperty(globalThis, "matchMedia", {
    value: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  });
}

const textScale: Change = {
  id: "bigger-text",
  summary: "Larger text",
  reason: "Request",
  css: null,
  dom: null,
  block: { name: "textScale", scale: 1.4 },
  scope: "page",
};

function cssChange(id: string, css: string): Change {
  return { id, summary: id, reason: "Request", css, dom: null, block: null, scope: "page" };
}

describe("font-size rules and text scale", () => {
  it("keeps a resting font-size rule ahead of text scale, including text that loads later", async () => {
    document.body.innerHTML = "<p id='copy'>Hello</p><a id='link' href='/a'>Link</a>";
    const { applyChange } = await import("../extension/src/content/engine.js");
    const path = location.pathname || "/";
    const scaled = await applyChange({ ...textScale, pagePath: path }, false);
    assert.equal(scaled.ok, true, scaled.error ?? "");
    const linkSize = document.getElementById("link")?.style.getPropertyPriority("font-size") ?? "";
    const sized = await applyChange({ ...cssChange("size", "p { font-size: 40px !important; }"), pagePath: path }, false);
    assert.equal(sized.ok, true, sized.error ?? "");
    assert.equal(document.getElementById("copy")?.style.getPropertyPriority("font-size") ?? "", "");
    assert.equal(document.getElementById("link")?.style.getPropertyPriority("font-size") ?? "", linkSize);

    const later = document.createElement("p");
    later.id = "later";
    later.textContent = "Later";
    document.body.append(later);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(document.getElementById("later")?.style.getPropertyPriority("font-size") ?? "", "");
  });

  it("does not release text scale for a hover-only font-size rule", async () => {
    document.body.innerHTML = "<a id='link' href='/a'>Link</a>";
    const { applyChange } = await import("../extension/src/content/engine.js");
    const path = location.pathname || "/";
    const scaled = await applyChange({ ...textScale, id: "bigger-text-hover", pagePath: path }, false);
    assert.equal(scaled.ok, true, scaled.error ?? "");
    const hover = await applyChange({ ...cssChange("hover", "a:hover { font-size: 40px !important; }"), pagePath: path }, false);
    assert.equal(hover.ok, true, hover.error ?? "");
    assert.equal(document.getElementById("link")?.style.getPropertyPriority("font-size") ?? "", "important");
  });
});

describe("dark mode no-op", () => {
  it("reports a flag when the page is already dark and does not stay applied", async () => {
    document.body.innerHTML = "<main style='background-color: rgb(10, 10, 10); color: rgb(240, 240, 240)'>Night</main>";
    const { activeChanges, applyChange } = await import("../extension/src/content/engine.js");
    const outcome = await applyChange({
      id: "dark-mode",
      summary: "Dark mode",
      reason: "Request",
      css: null,
      dom: null,
      block: { name: "darkMode", allowSiteControls: true },
      scope: "page",
      pagePath: location.pathname || "/",
    }, false);
    assert.equal(outcome.ok, true, outcome.error ?? "");
    assert.equal(outcome.noop, true);
    assert.equal(activeChanges().some((change) => change.id === "dark-mode"), false);
    let restored = 0;
    if (outcome.ok && !outcome.noop) restored++;
    assert.equal(restored, 0);
  });
});
