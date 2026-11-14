import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyTextScale } from "./text-scale";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

const cfg = (scale: number) => ({ block: "text_scale" as const, scale });

describe("text scale", () => {
  test("scales an element's px font-size with !important and undo restores the style attribute", () => {
    document.body.innerHTML = `<p style="color: red; font-size: 10px">Hello</p>`;
    const p = document.querySelector("p")!;
    const original = p.getAttribute("style");

    const undo = applyTextScale(cfg(1.5));
    expect(p.style.getPropertyValue("font-size")).toBe("15px");
    expect(p.style.getPropertyPriority("font-size")).toBe("important");

    undo();
    expect(p.getAttribute("style")).toBe(original);
    expect(p.style.getPropertyPriority("font-size")).toBe("");
  });

  test("an element with no style attribute has none after undo", () => {
    document.body.innerHTML = `<div><span>Some text</span></div>`;
    const span = document.querySelector("span")!;
    const undo = applyTextScale(cfg(1.3));
    expect(span.getAttribute("style")).not.toBeNull();
    undo();
    expect(span.hasAttribute("style")).toBe(false);
  });

  test("elements without their own text, scripts and our own nodes are left alone", () => {
    document.body.innerHTML = `
      <div id="wrap" style="font-size: 10px"><span style="font-size: 10px">x</span></div>
      <script>var a = 1;</script>
      <p data-ba style="font-size: 10px">ours</p>
    `;
    const undo = applyTextScale(cfg(2));
    expect(document.getElementById("wrap")!.style.getPropertyPriority("font-size")).toBe("");
    expect(document.querySelector("span")!.style.getPropertyPriority("font-size")).toBe("important");
    expect(document.querySelector("script")!.hasAttribute("style")).toBe(false);
    expect(document.querySelector("[data-ba]")!.getAttribute("style")).toBe("font-size: 10px");
    undo();
  });

  test("scale of 1 changes nothing", () => {
    document.body.innerHTML = `<p style="font-size: 10px">Hi</p>`;
    const undo = applyTextScale(cfg(1));
    expect(document.querySelector("p")!.getAttribute("style")).toBe("font-size: 10px");
    undo();
  });
});
