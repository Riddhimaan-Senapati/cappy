import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { BlockCall } from "../shared/adaptation.js";
import { installDom } from "./dom-setup.js";

installDom();
const { applyContentFilter, keywordPattern } = await import("../extension/src/content/content-filter.js");
const { findItemGroups } = await import("../extension/src/content/item-groups.js");

type Filter = Extract<BlockCall, { name: "contentFilter" }>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 320));
const card = (title: string, extra = "") =>
  `<div class="card-x1"><h3>${title}</h3><p>Some description text for ${title}</p>${extra}</div>`;

function filter(overrides: Partial<Filter>): Filter {
  return { name: "contentFilter", keywords: ["podcast"], itemSelector: null, action: "hide", ...overrides };
}

const hiddenTitles = () =>
  [...document.querySelectorAll<HTMLElement>("feed-card")]
    .filter((el) => el.style.display === "none")
    .map((el) => el.querySelector("h3")?.textContent);

describe("item group detection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds repeated custom elements by tag", () => {
    document.body.innerHTML = `<main>${[1, 2, 3, 4].map((i) => `<feed-card><span>Story number ${i} here</span></feed-card>`).join("")}</main>`;
    const groups = findItemGroups(document);
    assert.ok(groups.some((g) => g.selector === "feed-card" && g.count === 4), JSON.stringify(groups));
  });

  it("finds link patterns such as reels", () => {
    const nav = Array.from({ length: 10 }, (_, i) => `<a href="/nav/${i}">Navigation link ${i}</a>`).join("");
    document.body.innerHTML = `<nav>${nav}</nav><main><p><a href="/reel/1/">Reel caption number one</a></p><b><a href="/reel/2/">Reel caption number two</a></b><i><a href="/reel/3/">Reel caption number three</a></i></main>`;
    const groups = findItemGroups(document);
    assert.ok(groups.some((g) => g.selector === 'a[href*="/reel/"]' && g.count === 3), JSON.stringify(groups));
  });

  it("falls back to a structural path when classes are hashed", () => {
    const filler = Array.from({ length: 30 }, () => "<div></div>").join("");
    document.body.innerHTML = `<header>${filler}</header><main><div role="feed">${[1, 2, 3, 4, 5].map((i) => `<div class="a1b2c3 d4e5f6"><span>Hashed item text ${i} with words</span></div>`).join("")}</div></main>`;
    const groups = findItemGroups(document);
    assert.ok(groups.some((g) => g.selector === '[role="feed"] > div' && g.count === 5), JSON.stringify(groups));
  });
});

describe("content filter", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="grid">
      ${card("Carbonara from scratch").replace('class="card-x1"', 'class="card-x1" data-x=""')}
      ${card("Acquired Podcast: Nvidia")}
      ${card("Beginner yoga flow")}
      ${card("Podcasting for beginners")}
    </main>`;
    const items = document.querySelectorAll(".card-x1");
    items.forEach((node) => {
      const wrapper = document.createElement("feed-card");
      node.replaceWith(wrapper);
      wrapper.append(node);
    });
  });

  it("hides items whose text matches a whole keyword, plurals included", () => {
    const handle = applyContentFilter(filter({ keywords: ["podcast"] }), document);
    assert.deepEqual(hiddenTitles(), ["Acquired Podcast: Nvidia"]);
    assert.equal(handle.matched(), 1);
    handle.undo();
  });

  it("matches keywords in aria-label and link URLs", () => {
    document.querySelector("feed-card")!.setAttribute("aria-label", "Podcast clip");
    const handle = applyContentFilter(filter({ keywords: ["clip"] }), document);
    assert.equal(handle.matched(), 1);
    handle.undo();
  });

  it("filters items that load while scrolling", async () => {
    const handle = applyContentFilter(filter({ keywords: ["podcast"] }), document);
    const late = document.createElement("feed-card");
    late.innerHTML = card("Late podcast episode");
    document.querySelector("main")!.append(late);
    await settle();
    assert.ok(hiddenTitles().includes("Late podcast episode"));
    assert.equal(handle.matched(), 2);
    handle.undo();
  });

  it("undo restores every style attribute exactly", async () => {
    const items = [...document.querySelectorAll<HTMLElement>("feed-card")];
    items[1]!.setAttribute("style", "color: red;");
    const before = items.map((el) => el.getAttribute("style"));
    const handle = applyContentFilter(filter({ keywords: ["podcast"] }), document);
    const late = document.createElement("feed-card");
    late.innerHTML = card("Another podcast");
    document.querySelector("main")!.append(late);
    await settle();
    handle.undo();
    assert.deepEqual(items.map((el) => el.getAttribute("style")), before);
    assert.equal(late.getAttribute("style"), null);
    assert.equal(document.querySelectorAll('[style*="display"]').length, 0);
  });

  it("dim leaves items visible but faded", () => {
    const handle = applyContentFilter(filter({ action: "dim" }), document);
    const dimmed = document.querySelector<HTMLElement>('feed-card[style*="opacity"]');
    assert.ok(dimmed);
    assert.equal(dimmed.style.display, "");
    handle.undo();
    assert.equal(document.querySelectorAll('[style*="opacity"]').length, 0);
  });

  it("two filters holding the same item keep it hidden until both are undone", () => {
    const first = applyContentFilter(filter({ keywords: ["podcast"] }), document);
    const second = applyContentFilter(filter({ keywords: ["acquired"], itemSelector: "feed-card" }), document);
    const target = [...document.querySelectorAll<HTMLElement>("feed-card")].find((el) => el.textContent!.includes("Acquired"))!;
    first.undo();
    assert.equal(target.style.display, "none");
    second.undo();
    assert.equal(target.style.display, "");
  });

  it("an empty keyword list matches nothing", () => {
    assert.equal(keywordPattern([]).test("anything at all"), false);
  });

  it("escapes regex characters in keywords", () => {
    assert.equal(keywordPattern(["c++"]).test("learn c++ today"), true);
    assert.equal(keywordPattern(["c++"]).test("learn cxx today"), false);
  });
});
