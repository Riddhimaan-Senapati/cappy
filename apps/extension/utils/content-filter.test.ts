import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ContentFilter } from "@browser-agent/shared";
import { applyContentFilters, FILTER_DEBOUNCE_MS, keywordPattern } from "./content-filter";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const hideFilter = ContentFilter.parse({
  itemSelector: "ytd-rich-item-renderer",
  keywords: ["podcast"],
  action: "hide",
});

const tick = (ms = FILTER_DEBOUNCE_MS + 60) => new Promise((resolve) => setTimeout(resolve, ms));

function feed(): void {
  document.body.innerHTML = `
    <ytd-rich-item-renderer id="p1" style="color: red"><a href="/podcast/1">Tea history podcast</a></ytd-rich-item-renderer>
    <ytd-rich-item-renderer id="v2"><a href="/watch?v=2">Cooking a soup</a></ytd-rich-item-renderer>
    <ytd-rich-item-renderer id="p3"><span title="Daily podcasts">Language episode</span></ytd-rich-item-renderer>`;
}

describe("keywordPattern", () => {
  test("matches whole words and simple plurals only", () => {
    const pattern = keywordPattern(["podcast"]);
    expect(pattern.test("a podcast episode")).toBe(true);
    expect(pattern.test("two podcasts")).toBe(true);
    expect(pattern.test("podcastle reading")).toBe(false);
  });

  test("a filter with no usable keyword matches nothing", () => {
    expect(keywordPattern([" "]).test("anything at all")).toBe(false);
  });
});

describe("applyContentFilters", () => {
  test("hides only the items whose text, label or title matches", () => {
    feed();
    const undo = applyContentFilters([hideFilter], document);
    expect(document.getElementById("p1")!.style.display).toBe("none");
    expect(document.getElementById("p3")!.style.display).toBe("none");
    expect(document.getElementById("v2")!.style.display).toBe("");
    expect(undo.matched).toBe(2);
    undo();
  });

  test("dims instead of hiding when the action says so", () => {
    feed();
    const dim = ContentFilter.parse({ ...hideFilter, action: "dim" });
    const undo = applyContentFilters([dim], document);
    const el = document.getElementById("p1")!;
    expect(el.style.opacity).toBe("0.25");
    expect(el.style.filter).toBe("grayscale(1)");
    expect(el.style.display).toBe("");
    undo();
  });

  test("hides an item appended later by infinite scroll", async () => {
    feed();
    const undo = applyContentFilters([hideFilter], document);
    const late = document.createElement("ytd-rich-item-renderer");
    late.id = "late";
    late.innerHTML = `<a href="/podcast/9">A late podcast</a>`;
    document.body.append(late);
    await tick();
    expect(late.style.display).toBe("none");
    expect(undo.matched).toBe(3);
    undo();
  });

  test("undo restores the exact original style attributes and stops observing", async () => {
    feed();
    const before = Array.from(document.querySelectorAll("ytd-rich-item-renderer")).map((el) => el.getAttribute("style"));
    const undo = applyContentFilters([hideFilter], document);
    undo();
    const after = Array.from(document.querySelectorAll("ytd-rich-item-renderer")).map((el) => el.getAttribute("style"));
    expect(after).toEqual(before);
    expect(document.getElementById("p1")!.getAttribute("style")).toBe("color: red");

    const late = document.createElement("ytd-rich-item-renderer");
    late.innerHTML = `<a href="/podcast/10">Later podcast</a>`;
    document.body.append(late);
    await tick();
    expect(late.getAttribute("style")).toBeNull();
  });
});
