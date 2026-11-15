import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Change } from "../shared/adaptation.js";
import { installDom } from "./dom-setup.js";

installDom();
if (typeof document.getAnimations !== "function") {
  Object.defineProperty(document, "getAnimations", { value: () => [], configurable: true });
}
if (typeof matchMedia !== "function") {
  Object.defineProperty(globalThis, "matchMedia", {
    value: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  });
}

describe("reorder keywords", () => {
  it("puts keyword matches first when the ranking list is empty", async () => {
    document.body.innerHTML = "<div><article>News</article><article>Cooking pasta</article><article>Sports</article></div>";
    const { applyChange } = await import("../extension/src/content/engine.js");
    const change: Change = {
      id: "sort-cooking",
      summary: "Cooking first",
      reason: "Request",
      css: null,
      block: null,
      scope: "page",
      pagePath: location.pathname || "/",
      dom: [{ op: "reorder", selector: "article", keySelector: null, direction: "asc", ranking: [], keywords: ["cooking", "pasta"] }],
    };
    const outcome = await applyChange(change, false);
    assert.equal(outcome.ok, true, outcome.error ?? "");
    assert.deepEqual([...document.querySelectorAll("article")].map((node) => node.textContent), ["Cooking pasta", "News", "Sports"]);
  });
});
