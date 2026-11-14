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

describe("applyContentFilters without an item selector", () => {
  const everyGroup = ContentFilter.parse({ keywords: ["podcast"], action: "hide" });

  test("applies to every repeated item group on the page", () => {
    feed();
    const undo = applyContentFilters([everyGroup], document);
    expect(document.getElementById("p1")!.style.display).toBe("none");
    expect(document.getElementById("p3")!.style.display).toBe("none");
    expect(document.getElementById("v2")!.style.display).toBe("");
    undo();
  });

  test("hides matching items appended in batches far down the page", async () => {
    document.body.innerHTML = `<main><div id="grid"></div></main>`;
    const grid = document.getElementById("grid")!;
    const undo = applyContentFilters([everyGroup], document);
    const card = (i: number, kind: string) => `<ytd-rich-item-renderer data-batch="${i}"><a href="/${kind}/${i}">${kind} number ${i} from the feed</a></ytd-rich-item-renderer>`;
    for (let batch = 0; batch < 6; batch++) {
      const html = Array.from({ length: 5 }, (_, i) => card(batch * 5 + i, i % 2 === 0 ? "podcast" : "video")).join("");
      grid.insertAdjacentHTML("beforeend", html);
      await tick(60);
    }
    await tick();
    const items = Array.from(grid.querySelectorAll<HTMLElement>("ytd-rich-item-renderer"));
    expect(items.length).toBe(30);
    for (const item of items) {
      const podcast = item.textContent!.includes("podcast");
      expect(item.style.display).toBe(podcast ? "none" : "");
    }
    undo();
  });

  test("keeps applying while the page mutates faster than the debounce delay", async () => {
    document.body.innerHTML = `<main><div id="grid"></div></main>`;
    const grid = document.getElementById("grid")!;
    const undo = applyContentFilters([everyGroup], document);
    for (let i = 0; i < 20; i++) {
      grid.insertAdjacentHTML("beforeend", `<ytd-rich-item-renderer data-i="${i}"><a href="/x/${i}">podcast number ${i} from the feed</a></ytd-rich-item-renderer>`);
      await Bun.sleep(30);
    }
    await tick();
    const hidden = Array.from(grid.querySelectorAll<HTMLElement>("ytd-rich-item-renderer")).filter((el) => el.style.display === "none");
    expect(hidden.length).toBe(20);
    undo();
  });
});

describe("applyContentFilters with a schedule", () => {
  const weekdays9to5 = ContentFilter.parse({
    itemSelector: "ytd-rich-item-renderer",
    keywords: ["podcast"],
    action: "hide",
    schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
  });

  test("hides only while the schedule is active and follows the clock", async () => {
    feed();
    let at = new Date(2026, 10, 16, 10, 0); // Monday 10:00
    const undo = applyContentFilters([weekdays9to5], document, () => at);
    expect(document.getElementById("p1")!.style.display).toBe("none");

    at = new Date(2026, 10, 16, 18, 0);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.getElementById("p1")!.style.display).toBe("");
    expect(document.getElementById("p3")!.style.display).toBe("");

    const late = document.createElement("ytd-rich-item-renderer");
    late.innerHTML = `<a href="/podcast/11">Evening podcast</a>`;
    document.body.append(late);
    await tick();
    expect(late.style.display).toBe("");

    at = new Date(2026, 10, 16, 11, 0);
    undo.refresh();
    expect(document.getElementById("p1")!.style.display).toBe("none");
    expect(late.style.display).toBe("none");
    undo();
  });

  test("a weekend keeps the items visible", () => {
    feed();
    const at = new Date(2026, 10, 21, 10, 0); // Saturday
    const undo = applyContentFilters([weekdays9to5], document, () => at);
    expect(document.getElementById("p1")!.style.display).toBe("");
    undo();
  });

  test("the 30 second tick re-evaluates a schedule", async () => {
    feed();
    let at = new Date(2026, 10, 16, 18, 0);
    const undo = applyContentFilters([weekdays9to5], document, () => at);
    expect(document.getElementById("p1")!.style.display).toBe("");
    at = new Date(2026, 10, 16, 10, 0);
    const originalSetInterval = globalThis.setInterval;
    let tickFn: (() => void) | undefined;
    undo();
    globalThis.setInterval = ((fn: () => void) => {
      tickFn = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      const again = applyContentFilters([weekdays9to5], document, () => at);
      expect(tickFn).toBeDefined();
      tickFn!();
      expect(document.getElementById("p1")!.style.display).toBe("none");
      again();
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});

describe("overlapping filters", () => {
  test("undoing one filter keeps items that another filter still hides", () => {
    feed();
    const hide = applyContentFilters([hideFilter], document);
    const dim = applyContentFilters([ContentFilter.parse({ ...hideFilter, action: "dim", keywords: ["soup"] })], document);
    hide();
    expect(document.getElementById("p1")!.style.display).toBe("");
    expect(document.getElementById("p1")!.getAttribute("style")).toBe("color: red");
    expect(document.getElementById("v2")!.style.opacity).toBe("0.25");
    dim();
    expect(document.getElementById("v2")!.getAttribute("style")).toBeNull();
  });

  test("a rule that still hides an item keeps it hidden when a one-off change is undone", () => {
    feed();
    const rule = applyContentFilters([hideFilter], document);
    const oneOff = applyContentFilters([hideFilter], document);
    oneOff();
    expect(document.getElementById("p1")!.style.display).toBe("none");
    rule();
    expect(document.getElementById("p1")!.getAttribute("style")).toBe("color: red");
  });
});

describe("group targets never hide containers around unmatched items", () => {
  test("a keyword-only filter hides the matching cards but not the feed that holds the others", () => {
    document.body.innerHTML = `
      <div id="content"><div id="primary"><div id="grid">
        <ytd-rich-item-renderer id="p1"><h3>Tea podcast</h3><span>Podcast · new</span></ytd-rich-item-renderer>
        <ytd-rich-item-renderer id="v2"><h3>Cooking a soup</h3><span>Chef · new</span></ytd-rich-item-renderer>
        <ytd-rich-item-renderer id="v3"><h3>Bread basics</h3><span>Baker · new</span></ytd-rich-item-renderer>
        <ytd-rich-item-renderer id="p4"><h3>Daily podcast</h3><span>Daily · new</span></ytd-rich-item-renderer>
      </div></div></div>`;
    const undo = applyContentFilters([ContentFilter.parse({ keywords: ["podcast"], action: "hide" })], document);
    expect(document.getElementById("content")!.style.display).toBe("");
    expect(document.getElementById("primary")!.style.display).toBe("");
    expect(document.getElementById("v2")!.style.display).toBe("");
    expect(document.getElementById("v3")!.style.display).toBe("");
    expect(document.getElementById("p1")!.style.display).toBe("none");
    expect(document.getElementById("p4")!.style.display).toBe("none");
    undo();
  });
});
