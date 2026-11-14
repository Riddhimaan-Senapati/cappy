import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Journal } from "./journal";
import {
  accessibleName,
  applyThemeSwitch,
  darkMediaRuleTexts,
  findToggleCandidates,
  isDarkQuery,
  isDarkened,
  parseRgba,
  relativeLuminance,
  selectorsFromSheets,
  strategyOrder,
  themeSwitchesFromSelectors,
} from "./dark-mode";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
});

const shown = () => true;

describe("luminance math", () => {
  test("parses rgb, rgba and percent alpha", () => {
    expect(parseRgba("rgb(17, 17, 17)")).toEqual({ r: 17, g: 17, b: 17, a: 1 });
    expect(parseRgba("rgba(0, 0, 0, 0)")?.a).toBe(0);
    expect(parseRgba("rgb(255 255 255 / 50%)")?.a).toBe(0.5);
    expect(parseRgba("oklch(0.2 0 0)")).toBeUndefined();
  });

  test("black is 0, white is 1, and dark grey is below the 0.2 dark threshold", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 5);
    expect(relativeLuminance(parseRgba("rgb(17, 17, 17)")!)).toBeLessThan(0.2);
    expect(relativeLuminance(parseRgba("rgb(240, 240, 240)")!)).toBeGreaterThan(0.2);
  });

  test("a change only counts as dark when the background got darker and text stays lighter", () => {
    const light = { background: 1, text: 0 };
    const dark = { background: 0.006, text: 0.85 };
    expect(isDarkened(light, dark)).toBe(true);
    expect(isDarkened(light, { background: 0.5, text: 0.9 })).toBe(false);
    expect(isDarkened({ background: 0.1, text: 0.9 }, { background: 0.15, text: 0.9 })).toBe(false);
    expect(isDarkened(light, { background: 0.006, text: 0.001 })).toBe(false);
  });
});

describe("theme selector detection", () => {
  test("finds class and attribute switches in selector text", () => {
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
    expect(keys).toContain('{"kind":"class","name":"dark"}');
    expect(keys).toContain('{"kind":"attr","name":"data-theme","value":"dark"}');
    expect(keys).toContain('{"kind":"attr","name":"data-color-mode","value":"dark"}');
    expect(keys).toContain('{"kind":"class","name":"night"}');
    expect(keys).toContain('{"kind":"class","name":"dark-mode"}');
    expect(keys).toContain('{"kind":"class","name":"theme-dark"}');
    expect(keys.filter((k) => k === '{"kind":"class","name":"dark"}')).toHaveLength(1);
    expect(found.find((f) => f.token.kind === "class" && f.token.name === "night")?.alsoBody).toBe(true);
    expect(found.find((f) => f.token.kind === "class" && f.token.name === "dark")?.alsoBody).toBe(false);
  });

  test("does not treat a dark-prefixed class or a light attribute as a dark switch", () => {
    const found = themeSwitchesFromSelectors([".bg-dark-card", ".dark-header", '[data-theme="light"]', ".darkness"]);
    expect(found).toEqual([]);
  });

  test("reads selectors and dark media rules from real stylesheets", () => {
    document.head.innerHTML = `<style>
      html.dark { background: #111; color: #eee; }
      [data-theme="dark"] body { background: #111; }
      @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
      @media (prefers-color-scheme: light) { body { background: #fff; } }
    </style>`;
    const selectors = selectorsFromSheets(document.styleSheets);
    expect(selectors).toContain("html.dark");
    expect(selectors.some((s) => s.includes('[data-theme="dark"]'))).toBe(true);
    const media = darkMediaRuleTexts(document.styleSheets);
    expect(media).toHaveLength(1);
    expect(media[0]).toContain("background");
    expect(media[0]).toContain("#111");
  });

  test("the dark media query check ignores negated and light queries", () => {
    expect(isDarkQuery("(prefers-color-scheme: dark)")).toBe(true);
    expect(isDarkQuery("screen and (prefers-color-scheme:dark)")).toBe(true);
    expect(isDarkQuery("(prefers-color-scheme: light)")).toBe(false);
    expect(isDarkQuery("not (prefers-color-scheme: dark)")).toBe(false);
  });
});

describe("toggle candidates", () => {
  test("finds dark-mode toggles by accessible name and skips navigation and submit buttons", () => {
    document.body.innerHTML = `
      <button aria-label="Toggle dark mode">x</button>
      <button role="switch" title="Night mode"></button>
      <button>Dark</button>
      <button aria-label="Theme settings">s</button>
      <button>Subscribe</button>
      <a href="/theme">Dark theme</a>
      <form><button>Appearance</button></form>
      <form><button type="button">Theme</button></form>
      <button disabled>Dark</button>
    `;
    const names = findToggleCandidates(document, shown).map(accessibleName);
    expect(names).toEqual(["Toggle dark mode", "Night mode", "Dark", "Theme"]);
  });

  test("the accessible name prefers aria-label, then labelledby, then text, then title", () => {
    document.body.innerHTML = `
      <span id="lbl">Appearance</span>
      <button aria-label="One">Two</button>
      <button aria-labelledby="lbl">x</button>
      <button title="Dark"></button>
    `;
    const [a, b, c] = Array.from(document.querySelectorAll("button"));
    expect(accessibleName(a!)).toBe("One");
    expect(accessibleName(b!)).toBe("Appearance");
    expect(accessibleName(c!)).toBe("Dark");
  });
});

describe("undo restores what was changed", () => {
  test("a class switch restores the html class and attributes exactly", () => {
    document.documentElement.setAttribute("class", "light  brand");
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("lang", "en");
    const before = Array.from(document.documentElement.attributes, (a) => [a.name, a.value]);

    const journal = new Journal();
    applyThemeSwitch(journal, document, { token: { kind: "class", name: "dark" }, alsoBody: false });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");

    journal.unwind();
    expect(Array.from(document.documentElement.attributes, (a) => [a.name, a.value])).toEqual(before);
    expect(document.documentElement.getAttribute("class")).toBe("light  brand");
  });

  test("an attribute switch restores the original attribute value", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const journal = new Journal();
    applyThemeSwitch(journal, document, {
      token: { kind: "attr", name: "data-theme", value: "dark" },
      alsoBody: true,
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.body.hasAttribute("data-theme")).toBe(true);
    journal.unwind();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.body.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("");
  });
});

describe("strategy order", () => {
  test("tries the remembered strategy first and never toggles without site controls", () => {
    expect(strategyOrder(undefined, true)).toEqual(["class", "media", "toggle", "invert"]);
    expect(strategyOrder("invert", true)).toEqual(["invert", "class", "media", "toggle"]);
    expect(strategyOrder(undefined, false)).toEqual(["class", "media", "invert"]);
    expect(strategyOrder("toggle", false)).toEqual(["class", "media", "invert"]);
  });
});
