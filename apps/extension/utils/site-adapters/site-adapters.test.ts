import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ItemSelector, type ItemGroup } from "@browser-agent/shared";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KIND_HINTS, SITE_ADAPTERS, adapterGroups, mergeGroups } from "./index";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = "";
});

function load(html: string): void {
  document.body.innerHTML = html;
}

function summary(groups: ItemGroup[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const g of groups) {
    const key = g.label ?? g.selector;
    counts[key] = (counts[key] ?? 0) + g.count;
  }
  return counts;
}

describe("adapterGroups", () => {
  test("youtube finds cards, shelves, ads and search results", () => {
    load(`
      <ytd-rich-section-renderer><h2>Podcasts</h2></ytd-rich-section-renderer>
      <ytd-rich-item-renderer><a>Podcast: tea history</a></ytd-rich-item-renderer>
      <ytd-rich-item-renderer><a>A music video</a></ytd-rich-item-renderer>
      <ytd-reel-shelf-renderer><a>Shorts row</a></ytd-reel-shelf-renderer>
      <ytd-rich-shelf-renderer is-shorts><a>More shorts</a></ytd-rich-shelf-renderer>
      <ytd-ad-slot-renderer><a>Sponsored</a></ytd-ad-slot-renderer>
      <ytd-video-renderer><a>Search result</a></ytd-video-renderer>
      <ytd-compact-video-renderer><a>Up next</a></ytd-compact-video-renderer>
    `);
    expect(summary(adapterGroups("www.youtube.com", document))).toEqual({
      "Shelf (Shorts, Podcasts, …)": 1,
      "Video card": 2,
      "Shorts shelf": 2,
      Ad: 1,
      "Search result video": 1,
      "Sidebar recommendation": 1,
    });
  });

  test("instagram finds feed posts, reels and post tiles", () => {
    load(`
      <main>
        <article><a href="/p/abc/">Photo one</a></article>
        <article><a href="/p/def/">Photo two</a></article>
        <a href="/reel/xyz/">Reel</a>
        <a href="/p/ghi/">Tile</a>
      </main>
    `);
    expect(summary(adapterGroups("instagram.com", document))).toEqual({
      "Feed post": 2,
      Reel: 1,
      "Post tile": 3,
    });
  });

  test("x and twitter share the same adapter", () => {
    load(`
      <article data-testid="tweet">Hello</article>
      <article data-testid="tweet">Promoted: buy stuff</article>
      <div data-testid="trend">#topic</div>
    `);
    const expected = { Post: 2, Trend: 1 };
    expect(summary(adapterGroups("x.com", document))).toEqual(expected);
    expect(summary(adapterGroups("twitter.com", document))).toEqual(expected);
  });

  test("reddit separates posts from promoted posts", () => {
    load(`
      <shreddit-post>One</shreddit-post>
      <shreddit-post>Two</shreddit-post>
      <shreddit-ad-post>Ad</shreddit-ad-post>
    `);
    expect(summary(adapterGroups("reddit.com", document))).toEqual({ Post: 2, "Promoted post": 1 });
  });

  test("tiktok, linkedin and hacker news", () => {
    load(`
      <div data-e2e="recommend-list-item-container">v1</div>
      <div data-e2e="recommend-list-item-container">v2</div>
      <div data-id="urn:li:activity:1">p1</div>
      <div class="feed-shared-update-v2">p2</div>
      <table><tr class="athing">s1</tr><tr class="athing">s2</tr></table>
    `);
    expect(summary(adapterGroups("tiktok.com", document))).toEqual({ Video: 2 });
    expect(summary(adapterGroups("www.linkedin.com", document))).toEqual({
      "Feed post": 1,
      "Feed post (alt)": 1,
    });
    expect(summary(adapterGroups("news.ycombinator.com", document))).toEqual({ Story: 2 });
  });

  test("unknown host returns nothing", () => {
    load(`<ytd-rich-item-renderer>x</ytd-rich-item-renderer>`);
    expect(adapterGroups("example.com", document)).toEqual([]);
    expect(adapterGroups("notyoutube.com", document)).toEqual([]);
  });

  test("groups with no matches are skipped", () => {
    load(`<ytd-rich-item-renderer>only one</ytd-rich-item-renderer>`);
    const groups = adapterGroups("youtube.com", document);
    expect(groups.map((g) => g.label)).toEqual(["Video card"]);
  });

  test("counts grow as items are appended, so filters keep matching new cards", () => {
    load(`<ytd-rich-item-renderer><a>first</a></ytd-rich-item-renderer>`);
    expect(adapterGroups("youtube.com", document)[0]?.count).toBe(1);
    for (let i = 0; i < 5; i++) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<ytd-rich-item-renderer><a>later ${i}</a></ytd-rich-item-renderer>`,
      );
    }
    const group = adapterGroups("youtube.com", document)[0];
    expect(group?.count).toBe(6);
    expect(group?.samples).toHaveLength(3);
    expect(group?.source).toBe("adapter");
  });

  test("samples are normalized and capped at 100 characters", () => {
    load(`<shreddit-post>   ${"word ".repeat(60)}  </shreddit-post>`);
    const [group] = adapterGroups("reddit.com", document);
    expect(group?.samples[0]?.length).toBe(100);
    expect(group?.samples[0]).not.toMatch(/^\s/);
  });

  test("youtube fixture yields its video cards", async () => {
    const html = await Bun.file(join(import.meta.dir, "../../../../scripts/fixtures/youtube.html")).text();
    document.documentElement.innerHTML = html;
    const groups = adapterGroups("www.youtube.com", document);
    const cards = groups.find((g) => g.label === "Video card");
    expect(cards).toBeDefined();
    expect(cards!.count).toBe(document.querySelectorAll("ytd-rich-item-renderer").length);
    expect(cards!.count).toBeGreaterThan(0);
  });
});

describe("registry", () => {
  test("every selector is a valid ItemSelector", () => {
    for (const adapter of SITE_ADAPTERS) {
      for (const group of adapter.groups) {
        expect(ItemSelector.safeParse(group.selector).success).toBe(true);
      }
    }
  });

  test("every kind hint names a known KIND_HINTS entry", () => {
    for (const adapter of SITE_ADAPTERS) {
      for (const group of adapter.groups) {
        for (const hint of group.kindHints ?? []) {
          expect(KIND_HINTS[hint]).toBeDefined();
        }
      }
    }
  });
});

describe("mergeGroups", () => {
  const group = (selector: string, source?: "adapter" | "generic"): ItemGroup => ({
    selector,
    count: 1,
    samples: [],
    source,
  });

  test("dedupes by selector and the first list wins", () => {
    const merged = mergeGroups(
      [{ ...group("article"), label: "Feed post", source: "adapter" }],
      [group("article", "generic"), group("div.card", "generic")],
    );
    expect(merged.map((g) => g.selector)).toEqual(["article", "div.card"]);
    expect(merged[0]?.source).toBe("adapter");
    expect(merged[0]?.label).toBe("Feed post");
  });

  test("caps the result at 20 groups", () => {
    const a = Array.from({ length: 15 }, (_, i) => group(`a${i}`));
    const b = Array.from({ length: 15 }, (_, i) => group(`b${i}`));
    const merged = mergeGroups(a, b);
    expect(merged).toHaveLength(20);
    expect(merged[19]?.selector).toBe("b4");
  });
});
