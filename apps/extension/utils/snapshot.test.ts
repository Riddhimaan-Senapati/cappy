import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildSnapshot, SNAPSHOT_MAX, SNAPSHOT_TEXT_MAX } from "./snapshot";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("buildSnapshot", () => {
  test("assigns ids in document order to meaningful elements only", () => {
    document.body.innerHTML = `
      <script>var x = 1;</script>
      <div class="wrapper"><span></span></div>
      <h1>Feed</h1>
      <a href="/a">Read more</a>
      <p>Plain paragraph text</p>
      <button>Subscribe</button>`;
    const { elements } = buildSnapshot(document);
    expect(elements.map((e) => [e.id, e.tag, e.text])).toEqual([
      ["n1", "h1", "Feed"],
      ["n2", "a", "Read more"],
      ["n3", "p", "Plain paragraph text"],
      ["n4", "button", "Subscribe"],
    ]);
  });

  test("the map points at the same live elements the ids name", () => {
    document.body.innerHTML = `<button id="go">Go</button><nav>Menu</nav>`;
    const { elements, map } = buildSnapshot(document);
    expect(map.get(elements[0]!.id)).toBe(document.getElementById("go"));
    expect(map.get(elements[1]!.id)?.localName).toBe("nav");
    expect(map.size).toBe(elements.length);
  });

  test("does not change the real DOM", () => {
    document.body.innerHTML = `<aside class="side">Recommended</aside>`;
    const before = document.body.innerHTML;
    buildSnapshot(document);
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector("aside")!.getAttribute("data-ba")).toBeNull();
  });

  test("skips hidden elements and their subtrees", () => {
    document.body.innerHTML = `
      <button style="display:none">Gone</button>
      <div style="display:none"><a href="/x">Also gone</a></div>
      <button hidden>Hidden attr</button>
      <button>Visible</button>`;
    expect(buildSnapshot(document).elements.map((e) => e.text)).toEqual(["Visible"]);
  });

  test("skips our own data-ba nodes and their subtrees", () => {
    document.body.innerHTML = `<div data-ba="banner"><button>Undo</button></div><button>Keep</button>`;
    expect(buildSnapshot(document).elements.map((e) => e.text)).toEqual(["Keep"]);
  });

  test("images count only with alt text, and alt is their label", () => {
    document.body.innerHTML = `<img src="a.png"><img src="b.png" alt="Chart of sales">`;
    const { elements } = buildSnapshot(document);
    expect(elements.map((e) => [e.tag, e.text])).toEqual([["img", "Chart of sales"]]);
  });

  test("elements with role count and keep the role", () => {
    document.body.innerHTML = `<div role="complementary">Extras</div>`;
    expect(buildSnapshot(document).elements).toEqual([
      { id: "n1", tag: "div", role: "complementary", text: "Extras" },
    ]);
  });

  test("inputs are labelled without reading their values", () => {
    document.body.innerHTML = `<input type="password" value="hunter2" placeholder="Password">`;
    const [el] = buildSnapshot(document).elements;
    expect(el?.text).toBe("Password");
    expect(JSON.stringify(el)).not.toContain("hunter2");
  });

  test("collapses whitespace and caps text length", () => {
    document.body.innerHTML = `<p>${"word   ".repeat(60)}</p>`;
    const [el] = buildSnapshot(document).elements;
    expect(el!.text.length).toBeLessThanOrEqual(SNAPSHOT_TEXT_MAX);
    expect(el!.text).not.toMatch(/\s{2}/);
  });

  test("stops at the element cap", () => {
    document.body.innerHTML = Array.from({ length: SNAPSHOT_MAX + 50 }, (_, i) => `<li>item ${i}</li>`).join("");
    const { elements, map } = buildSnapshot(document);
    expect(elements).toHaveLength(SNAPSHOT_MAX);
    expect(map.size).toBe(SNAPSHOT_MAX);
    expect(elements.at(-1)!.id).toBe(`n${SNAPSHOT_MAX}`);
  });
});

describe("buildSnapshot main content", () => {
  test("visits the main content before masthead and navigation", () => {
    document.body.innerHTML = `
      <header><button>Sign in</button></header>
      <nav><a href="/x">Guide link</a></nav>
      <main><h2>Feed card</h2></main>`;
    const texts = buildSnapshot(document).elements.map((e) => e.text);
    expect([...new Set(texts)]).toEqual(["Feed card", "Sign in", "Guide link"]);
    expect(texts.indexOf("Feed card")).toBeLessThan(texts.indexOf("Sign in"));
  });

  test("a masthead cannot push the feed out of the element budget", () => {
    const masthead = Array.from({ length: SNAPSHOT_MAX }, (_, i) => `<button>Menu ${i}</button>`).join("");
    document.body.innerHTML = `${masthead}<div id="content"><h3>Podcast episode about cooking</h3></div>`;
    expect(buildSnapshot(document).elements.map((e) => e.text)).toContain("Podcast episode about cooking");
  });
});
