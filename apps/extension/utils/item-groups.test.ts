import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { findItemGroups } from "./item-groups";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

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
    expect(groups[0]).toEqual({ selector: "section.shelf", count: 1, samples: ["Podcasts for you"] });
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
});
