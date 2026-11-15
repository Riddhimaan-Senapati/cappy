import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  Journal,
  applyThemeSwitch,
  darkMediaRuleTexts,
  isDarkQuery,
  isDarkened,
  parseRgba,
  relativeLuminance,
  selectorsFromSheets,
  strategyOrder,
  themeSwitchesFromSelectors,
} from "../extension/src/content/dark-mode.js";

if (!globalThis.document) GlobalRegistrator.register();

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("luminance math", () => {
  it("parses rgb, rgba and percent alpha", () => {
    assert.deepEqual(parseRgba("rgb(17, 17, 17)"), { r: 17, g: 17, b: 17, a: 1 });
    assert.equal(parseRgba("rgba(0, 0, 0, 0)")?.a, 0);
    assert.equal(parseRgba("rgb(255 255 255 / 50%)")?.a, 0.5);
    assert.equal(parseRgba("oklch(0.2 0 0)"), undefined);
  });

  it("black is 0, white is 1, and dark grey is below the dark threshold", () => {
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
    assert.ok(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }) - 1) < 1e-5);
    assert.ok(relativeLuminance(parseRgba("rgb(17, 17, 17)")!) < 0.2);
    assert.ok(relativeLuminance(parseRgba("rgb(240, 240, 240)")!) > 0.2);
  });

  it("a change only counts as dark when the background got darker and text stays lighter", () => {
    const light = { background: 1, text: 0 };
    assert.equal(isDarkened(light, { background: 0.006, text: 0.85 }), true);
    assert.equal(isDarkened(light, { background: 0.5, text: 0.9 }), false);
    assert.equal(isDarkened({ background: 0.1, text: 0.9 }, { background: 0.15, text: 0.9 }), false);
    assert.equal(isDarkened(light, { background: 0.006, text: 0.001 }), false);
  });
});

describe("theme selector detection", () => {
  it("finds class and attribute switches in selector text", () => {
    const found = themeSwitchesFromSelectors([
      ".dark .card",
      "html.dark",
      '[data-theme="dark"]',
      "[data-color-mode='dark'] .x",
      "body.night",
      ".dark-mode",
      ".theme-dark, .unrelated",
      '[data-theme="light"]',
    ]);
    const keys = found.map((f) => JSON.stringify(f.token));
    assert.ok(keys.includes('{"kind":"class","name":"dark"}'));
    assert.ok(keys.includes('{"kind":"attr","name":"data-theme","value":"dark"}'));
    assert.ok(keys.includes('{"kind":"attr","name":"data-color-mode","value":"dark"}'));
    assert.ok(keys.includes('{"kind":"class","name":"night"}'));
    assert.ok(keys.includes('{"kind":"class","name":"dark-mode"}'));
    assert.ok(keys.includes('{"kind":"class","name":"theme-dark"}'));
    assert.equal(keys.filter((k) => k === '{"kind":"class","name":"dark"}').length, 1);
    assert.equal(found.find((f) => f.token.kind === "class" && f.token.name === "night")?.alsoBody, true);
    assert.equal(found.find((f) => f.token.kind === "class" && f.token.name === "dark")?.alsoBody, false);
  });

  it("does not treat a dark-prefixed class or a light attribute as a dark switch", () => {
    assert.deepEqual(themeSwitchesFromSelectors([".bg-dark-card", ".dark-header", '[data-theme="light"]', ".darkness"]), []);
  });

  it("reads selectors and dark media rules from real stylesheets", () => {
    document.head.innerHTML = `<style>
      html.dark { background: #111; color: #eee; }
      [data-theme="dark"] body { background: #111; }
      @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
      @media (prefers-color-scheme: light) { body { background: #fff; } }
    </style>`;
    const selectors = selectorsFromSheets(document.styleSheets);
    assert.ok(selectors.includes("html.dark"));
    assert.ok(selectors.some((s) => s.includes('[data-theme="dark"]')));
    const media = darkMediaRuleTexts(document.styleSheets);
    assert.equal(media.length, 1);
    assert.ok(media[0]!.includes("background"));
    assert.ok(media[0]!.includes("#111"));
  });

  it("the dark media query check ignores negated and light queries", () => {
    assert.equal(isDarkQuery("(prefers-color-scheme: dark)"), true);
    assert.equal(isDarkQuery("screen and (prefers-color-scheme:dark)"), true);
    assert.equal(isDarkQuery("(prefers-color-scheme: light)"), false);
    assert.equal(isDarkQuery("not (prefers-color-scheme: dark)"), false);
  });
});

describe("undo restores what was changed", () => {
  it("a class switch restores the html class, attributes and inline style exactly", () => {
    document.documentElement.setAttribute("class", "light  brand");
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("lang", "en");
    const before = Array.from(document.documentElement.attributes, (a) => [a.name, a.value]);

    const journal = new Journal();
    applyThemeSwitch(journal, document, { token: { kind: "class", name: "dark" }, alsoBody: false });
    assert.equal(document.documentElement.classList.contains("dark"), true);
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark");

    journal.unwind();
    assert.deepEqual(Array.from(document.documentElement.attributes, (a) => [a.name, a.value]), before);
    assert.equal(document.documentElement.getAttribute("class"), "light  brand");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "");
  });

  it("an attribute switch on html and body restores both elements", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const journal = new Journal();
    applyThemeSwitch(journal, document, {
      token: { kind: "attr", name: "data-theme", value: "dark" },
      alsoBody: true,
    });
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(document.body.getAttribute("data-theme"), "dark");
    journal.unwind();
    assert.equal(document.documentElement.getAttribute("data-theme"), "light");
    assert.equal(document.body.hasAttribute("data-theme"), false);
  });
});

describe("invert keeps images the original color", () => {
  it("re-inverts pictures with invert(1) and does not hue-rotate them into maroon", async () => {
    const { INVERT_CSS } = await import("../extension/src/content/dark-mode.js");
    assert.match(INVERT_CSS, /html \{ filter: invert\(1\) !important/);
    assert.match(INVERT_CSS, /img, video, picture, canvas, svg, iframe[\s\S]*\{ filter: invert\(1\) !important/);
    assert.equal(INVERT_CSS.includes("hue-rotate"), false);
  });
});

describe("invert keeps colored surfaces and dark boxes", () => {
  it("re-inverts a dark box once, leaves the photo inside it, and ignores a white divider", async () => {
    const { preserveSurfaces } = await import("../extension/src/content/dark-mode.js");
    document.body.innerHTML = `
      <div id="popup" style="background-color: rgb(34, 34, 34); color: rgb(221, 221, 221)">
        <img id="photo" alt="">
        <b>Don't miss a story</b>
      </div>
      <div id="bar" style="background-color: rgb(255, 59, 59); color: rgb(255, 255, 255)">News</div>
      <span id="chip" style="background-color: rgb(76, 175, 80)"></span>
      <div id="rule" style="background-color: rgb(255, 255, 255)"></div>
      <div id="nav" style="background-color: rgb(20, 20, 20)">
        <div id="menu" style="position: absolute">Item</div>
      </div>`;
    const undos = preserveSurfaces(document);
    const filterOf = (id: string) => document.getElementById(id)?.style.getPropertyValue("filter");
    assert.equal(filterOf("popup"), "invert(1)");
    assert.equal(filterOf("photo"), "none");
    assert.equal(filterOf("bar"), "invert(1)");
    assert.equal(filterOf("chip"), "invert(1)");
    assert.equal(filterOf("rule"), "");
    assert.equal(filterOf("nav"), "");
    assert.equal(document.getElementById("popup")?.querySelector("b")?.getAttribute("style"), null);

    const popup = document.getElementById("popup")!;
    popup.style.setProperty("filter", "blur(2px)");
    undos.forEach((undo) => undo());
    assert.equal(popup.style.getPropertyValue("filter"), "blur(2px)");
    assert.equal(filterOf("bar"), "");
  });

  it("preserves a popup that appears after dark mode", async () => {
    const { preserveSurfaces } = await import("../extension/src/content/dark-mode.js");
    document.body.innerHTML = `<div id="early" style="background-color: rgb(34, 34, 34)">Now</div>`;
    preserveSurfaces(document);
    const late = document.createElement("div");
    late.id = "late";
    late.style.backgroundColor = "rgb(34, 34, 34)";
    const photo = document.createElement("img");
    photo.id = "late-photo";
    late.append(photo);
    document.body.append(late);
    preserveSurfaces(document, [late]);
    assert.equal(late.style.getPropertyValue("filter"), "invert(1)");
    assert.equal(photo.style.getPropertyValue("filter"), "none");
    const extra = document.createElement("img");
    extra.id = "extra-photo";
    late.append(extra);
    preserveSurfaces(document, [extra]);
    assert.equal(extra.style.getPropertyValue("filter"), "none");
  });
});

describe("strategy order", () => {
  it("tries the remembered strategy first", () => {
    assert.deepEqual(strategyOrder(undefined), ["class", "media", "invert"]);
    assert.deepEqual(strategyOrder("invert"), ["invert", "class", "media"]);
  });
});
