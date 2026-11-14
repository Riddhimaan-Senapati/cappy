import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ItemSelector, type ItemGroup } from "@browser-agent/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { findItemGroups, watchItemGroups } from "./item-groups";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const FIXTURES = join(import.meta.dir, "../../../scripts/fixtures");

// Loads a fixture's static markup without running its inline scripts, so tests can append the same batch the page would.
function loadFixture(name: string): void {
  const html = readFileSync(join(FIXTURES, name), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  document.body.innerHTML = parsed.body.innerHTML;
}

function fromTemplate(id: string): DocumentFragment {
  const template = document.getElementById(id) as HTMLTemplateElement;
  return template.content.cloneNode(true) as DocumentFragment;
}

function matches(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector));
}

function groupFor(groups: ItemGroup[], selector: string): ItemGroup {
  const group = groups.find((g) => g.selector === selector);
  if (!group) throw new Error(`no group for ${selector}: ${JSON.stringify(groups.map((g) => g.selector))}`);
  return group;
}

function expectValidGroups(groups: ItemGroup[]): void {
  for (const group of groups) {
    expect(ItemSelector.safeParse(group.selector).success).toBe(true);
    expect(matches(group.selector).length).toBe(group.count);
    expect(group.source).toBe("generic");
  }
}

describe("findItemGroups", () => {
  test("finds a repeated custom element group with its item count and samples", () => {
    document.body.innerHTML = `
      <main>
        <ytd-rich-item-renderer><a href="/p1">Podcast: the history of tea</a></ytd-rich-item-renderer>
        <ytd-rich-item-renderer><a href="/p2">Podcast: learning Spanish daily</a></ytd-rich-item-renderer>
        <ytd-rich-item-renderer><a href="/v3">A music video worth watching</a></ytd-rich-item-renderer>
      </main>`;
    const group = findItemGroups(document).find((g) => g.selector === "ytd-rich-item-renderer");
    expect(group).toEqual({
      selector: "ytd-rich-item-renderer",
      count: 3,
      samples: [
        "Podcast: the history of tea",
        "Podcast: learning Spanish daily",
        "A music video worth watching",
      ],
      source: "generic",
    });
  });

  test("a section with a heading becomes a group even when it appears once", () => {
    document.body.innerHTML = `
      <main>
        <section class="shelf">
          <h2>Podcasts for you</h2>
          <p>Listen to the newest episodes from creators you follow</p>
        </section>
      </main>`;
    const groups = findItemGroups(document);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      selector: "section.shelf",
      count: 1,
      samples: ["Podcasts for you"],
      source: "generic",
    });
  });

  test("ignores short text and hidden repeats", () => {
    document.body.innerHTML = `
      <main>
        <div class="tag">Ad</div><div class="tag">New</div><div class="tag">Hot</div>
        <div class="card" style="display:none">Hidden card with plenty of text</div>
        <div class="card" style="display:none">Another hidden card with text</div>
      </main>`;
    expect(findItemGroups(document)).toEqual([]);
  });

  test("uses tag and stable classes for plain elements and skips hashed class names", () => {
    document.body.innerHTML = `
      <main>
        <article class="post css-1x2y3z">Recipe for a long weekend lunch</article>
        <article class="post css-9q8w7e">Notes on a quiet morning walk</article>
      </main>`;
    expect(findItemGroups(document).map((g) => g.selector)).toEqual(["article.post"]);
  });

  test("every returned selector matches the document", () => {
    document.body.innerHTML = Array.from(
      { length: 4 },
      (_, i) => `<ytd-reel-shelf-renderer><span>Shelf number ${i} with words</span></ytd-reel-shelf-renderer>`,
    ).join("");
    for (const group of findItemGroups(document)) {
      expect(document.querySelectorAll(group.selector).length).toBe(group.count);
    }
  });

  test("falls back to a structural path when hashed divs carry no stable hooks", () => {
    const sidebar = Array.from({ length: 20 }, () => `<div class="x3d4"><b>x</b></div>`).join("");
    const posts = Array.from(
      { length: 5 },
      (_, i) => `<div class="x1abc2"><div class="x9q8"><span>Feed post number ${i} with words</span></div></div>`,
    ).join("");
    document.body.innerHTML = `<main>${sidebar}<div role="feed">${posts}</div></main>`;
    const group = groupFor(findItemGroups(document), '[role="feed"] > div');
    expect(group.count).toBe(5);
    expect(group.samples[0]).toBe("Feed post number 0 with words");
  });

  test("falls back to a link-pattern group when the links have no item wrapper", () => {
    document.body.innerHTML = `
      <div><a href="/home">Home</a><a href="/search">Search</a><a href="/settings">Settings</a></div>
      <div class="x1">
        <a class="x2" href="/reel/r1/"><img alt="Morning run"></a>
        <a class="x2" href="/reel/r2/"><img alt="Night swim"></a>
        <a class="x2" href="/reel/r3/"><img alt="Bike ride"></a>
      </div>`;
    const group = groupFor(findItemGroups(document), 'a[href*="/reel/"]');
    expect(group.count).toBe(3);
    expect(group.samples).toEqual(["Morning run: /reel/r1/", "Night swim: /reel/r2/", "Bike ride: /reel/r3/"]);
  });
});

describe("instagram fixture", () => {
  test("a group matches exactly the eight posts, and the reels group matches the six reels", () => {
    loadFixture("instagram.html");
    const groups = findItemGroups(document);
    expectValidGroups(groups);

    const posts = groupFor(groups, "article");
    expect(matches(posts.selector)).toEqual(matches("article"));
    expect(posts.count).toBe(8);
    expect(posts.samples[0]).toContain("harbour");

    const reels = groupFor(groups, "li");
    const reelItems = matches('[data-expect="reel"]');
    expect(reelItems.length).toBe(6);
    expect(matches(reels.selector)).toEqual(reelItems);
    expect(reels.samples[0]).toBe("Reel by user: /reel/C1abc123/");
  });

  test("the group keeps matching posts and reels appended by infinite scroll", () => {
    loadFixture("instagram.html");
    const before = groupFor(findItemGroups(document), "article");
    const feed = document.querySelector("article")!.parentElement!;
    feed.appendChild(fromTemplate("later-posts"));
    expect(matches("article").length).toBe(before.count + 4);
    expect(groupFor(findItemGroups(document), "article").count).toBe(12);

    const reelList = document.querySelector("li")!.parentElement!;
    reelList.appendChild(fromTemplate("later-reels"));
    expect(matches('[data-expect="reel"]').filter((el) => el.localName === "li").length).toBe(9);
    expect(groupFor(findItemGroups(document), "li").count).toBe(9);
  });

  test("the podcast posts are inside the posts group", () => {
    loadFixture("instagram.html");
    const posts = new Set(matches(groupFor(findItemGroups(document), "article").selector));
    const podcasts = matches('article[data-expect="podcast"]');
    expect(podcasts.length).toBe(3);
    for (const post of podcasts) expect(posts.has(post)).toBe(true);
  });
});

describe("x fixture", () => {
  test("the timeline group matches every tweet via data-testid", () => {
    loadFixture("x.html");
    const groups = findItemGroups(document);
    expectValidGroups(groups);

    const tweets = groupFor(groups, 'article[data-testid="tweet"]');
    expect(matches(tweets.selector)).toEqual(matches('[data-testid="tweet"]'));
    expect(tweets.count).toBe(10);
    expect(matches('[data-expect="promoted"]').length).toBe(3);
    expect(matches('[data-expect="podcast"]').length).toBe(2);
  });

  test("the timeline group keeps matching tweets appended after load", () => {
    loadFixture("x.html");
    const timeline = document.querySelector('[aria-label^="Timeline"]')!;
    timeline.appendChild(fromTemplate("later-tweets"));
    const groups = findItemGroups(document);
    expect(groupFor(groups, 'article[data-testid="tweet"]').count).toBe(15);
    expect(matches('[data-testid="tweet"]').filter((el) => el.getAttribute("data-expect") === "promoted").length).toBe(4);
  });
});

describe("watchItemGroups", () => {
  test("reports the groups again, once, after a debounced batch of appended items", async () => {
    document.body.innerHTML = `<main><article class="x1a">${"Post text long enough to count"}</article>
      <article class="x1a">Post text long enough to count</article>
      <article class="x1a">Post text long enough to count</article></main>`;
    const seen: ItemGroup[][] = [];
    const stop = watchItemGroups(document, (groups) => seen.push(groups));

    const main = document.querySelector("main")!;
    for (let i = 0; i < 3; i++) {
      const post = document.createElement("article");
      post.textContent = `Appended post ${i} with enough text`;
      main.appendChild(post);
    }
    await Bun.sleep(450);
    expect(seen).toHaveLength(1);
    expect(groupFor(seen[0]!, "article").count).toBe(6);

    stop();
    const late = document.createElement("article");
    late.textContent = "Late post after stop has enough text";
    main.appendChild(late);
    await Bun.sleep(450);
    expect(seen).toHaveLength(1);
  });
});
