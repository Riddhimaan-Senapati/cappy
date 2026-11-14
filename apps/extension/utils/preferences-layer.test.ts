import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyPreferenceLayer } from "./preferences-layer";
import type { PreferenceLayer } from "./preferences";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "<p>Hello</p>";
  document.querySelectorAll("[data-ba]").forEach((el) => el.remove());
});

const layer: PreferenceLayer = {
  css: "html { filter: invert(1); }",
  blocks: [{ block: "text_scale", scale: 1.2 }, { block: "color_fix", mode: "protanopia", targets: ["images"] }],
  filters: [],
};

describe("applyPreferenceLayer", () => {
  test("puts its css in a data-ba style on the html element and removes it on undo", () => {
    const undo = applyPreferenceLayer(layer, document);
    const style = document.documentElement.querySelector('style[data-ba="preferences"]');
    expect(style?.textContent).toContain("filter: invert(1);");
    expect(style?.textContent).toContain("url(#ba-cvd-protanopia)");
    expect(document.getElementById("adaptive-agent-preference-filters")).not.toBeNull();
    undo();
    expect(document.querySelector('style[data-ba="preferences"]')).toBeNull();
    expect(document.getElementById("adaptive-agent-preference-filters")).toBeNull();
  });

  test("an empty layer adds no nodes", () => {
    const undo = applyPreferenceLayer({ blocks: [], filters: [] }, document);
    expect(document.querySelector("[data-ba]")).toBeNull();
    undo();
    expect(document.body.innerHTML).toBe("<p>Hello</p>");
  });

  test("leaves other data-ba nodes alone", () => {
    const other = document.createElement("style");
    other.setAttribute("data-ba", "adaptation");
    document.documentElement.append(other);
    const undo = applyPreferenceLayer(layer, document);
    undo();
    expect(document.documentElement.contains(other)).toBe(true);
  });
});
