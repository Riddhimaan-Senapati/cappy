import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { BlockCall } from "../shared/adaptation.js";
import { installDom } from "./dom-setup.js";

installDom();
const { applyContentFilter, keywordPattern, setFilterClassifier } = await import("../extension/src/content/content-filter.js");
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

describe("content filter judged by meaning", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const feed = (titles: string[]) => titles.map((title) => `<feed-card><h3>${title}</h3></feed-card>`).join("");

  it("hides items the keywords miss, including ones that load later, and judges each title once", async () => {
    const asked: string[][] = [];
    setFilterClassifier(async (_match, items) => {
      asked.push(items);
      return items.map((item) => /minecraft|elden ring|fortnite|zelda/i.test(item));
    });
    document.body.innerHTML = `<main>${feed(["Minecraft day 100", "How CPUs work", "Elden Ring boss guide", "Gaming news roundup"])}</main>`;
    const handle = applyContentFilter(filter({ keywords: ["gaming"], itemSelector: "feed-card", match: "gaming videos" }), document);
    assert.deepEqual(hiddenTitles(), ["Gaming news roundup"]);
    await wait(700);
    assert.deepEqual(hiddenTitles(), ["Minecraft day 100", "Elden Ring boss guide", "Gaming news roundup"]);

    document.querySelector("main")!.insertAdjacentHTML("beforeend", feed(["Fortnite trailer", "Cooking pasta", "Minecraft day 100"]));
    await wait(700);
    assert.deepEqual(hiddenTitles(), ["Minecraft day 100", "Elden Ring boss guide", "Gaming news roundup", "Fortnite trailer", "Minecraft day 100"]);
    const judged = asked.flat();
    assert.equal(judged.filter((text) => text.startsWith("Minecraft day 100")).length, 1);
    assert.ok(!judged.some((text) => text.startsWith("Gaming news roundup")));

    handle.undo();
    assert.deepEqual(hiddenTitles(), []);
    setFilterClassifier(null);
  });
});

describe("YouTube search results", () => {
  const video = (title: string, i: number) =>
    `<ytd-video-renderer><a href="/watch?v=v${i}"><h3 id="video-title">${title}</h3></a><div id="channel">Channel ${i} · ${i}M views · 2 weeks ago</div></ytd-video-renderer>`;
  // Search-page Shorts show only a view count; the link is what says they are Shorts.
  const short = (i: number) =>
    `<ytm-shorts-lockup-view-model-v2><a href="/shorts/s${i}"><img alt=""></a><div class="subhead">${i}m views</div></ytm-shorts-lockup-view-model-v2>`;
  const page = (resultsHeading = "") => {
    document.body.innerHTML = `<ytd-app><div id="primary"><ytd-item-section-renderer>${resultsHeading}<div id="contents">
      <ytd-shelf-renderer><h2><span id="title">Podcasts</span></h2><a href="/feed/podcasts">View all</a><div id="items">${["Trump episode 12 explained", "Mark Cuban the brutal truth", "Diary of a CEO interview", "Huberman sleep science"].map(video).join("")}</div></ytd-shelf-renderer>
      <grid-shelf-view-model><yt-shelf-header-layout><h2><span>Shorts</span></h2></yt-shelf-header-layout><div class="row">${[1, 2, 3, 4, 5].map(short).join("")}</div></grid-shelf-view-model>
      ${["Cooking pasta at home tonight", "Learn guitar in ten minutes", "Funny cats compilation 2026"].map((title, i) => video(title, i + 10)).join("")}
    </div></ytd-item-section-renderer></div></ytd-app>`;
  };
  const hidden = () => [...document.querySelectorAll<HTMLElement>("*")].filter((el) => el.style.display === "none").map((el) => el.localName);
  const visibleVideos = () => [...document.querySelectorAll<HTMLElement>("ytd-video-renderer")].filter((el) => !el.closest<HTMLElement>("[style*='none']")).length;

  it("hides the Shorts shelf and nothing else", async () => {
    page();
    const handle = applyContentFilter(filter({ keywords: ["shorts"] }), document);
    await settle();
    assert.deepEqual(hidden(), ["grid-shelf-view-model"]);
    assert.equal(visibleVideos(), 7);
    handle.undo();
  });

  it("hides a shelf by its heading, heading included, even when its items never say the word", async () => {
    page();
    const handle = applyContentFilter(filter({ keywords: ["podcast"] }), document);
    await settle();
    assert.deepEqual(hidden(), ["ytd-shelf-renderer"]);
    assert.equal(visibleVideos(), 3);
    handle.undo();
  });

  it("keeps a result list whose heading matches, since it holds most of the page", async () => {
    page(`<h2>Results for podcasts</h2>`);
    const handle = applyContentFilter(filter({ keywords: ["podcast"] }), document);
    await settle();
    assert.equal(hidden().includes("ytd-item-section-renderer"), false);
    handle.undo();
  });

  it("falls back to the page's own groups when a saved item selector matches nothing here", async () => {
    page();
    const handle = applyContentFilter(filter({ keywords: ["shorts"], itemSelector: "ytd-rich-item-renderer" }), document);
    await settle();
    assert.deepEqual(hidden(), ["grid-shelf-view-model"]);
    handle.undo();
  });
});
