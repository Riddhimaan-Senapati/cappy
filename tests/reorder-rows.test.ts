import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Change } from "../shared/adaptation.js";
import { installDom } from "./dom-setup.js";

installDom();
if (typeof document.getAnimations !== "function") {
  Object.defineProperty(document, "getAnimations", { value: () => [], configurable: true });
}
if (typeof matchMedia !== "function") {
  Object.defineProperty(globalThis, "matchMedia", {
    value: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  });
}

const story = (rank: string, title: string, points: number) =>
  `<tr class="athing"><td class="title"><span class="rank">${rank}</span></td><td><a>${title}</a></td></tr>` +
  `<tr><td colspan="2" class="subtext"><span class="score">${points} points</span> by someone</td></tr>` +
  `<tr class="spacer"></tr>`;

describe("reorder keeps a multi-row story together and sorts by points", () => {
  it("moves the title, subtext, and spacer as one group when there is no ranking", async () => {
    document.body.innerHTML = `<table><tbody>${story("1.", "Low score story", 10)}${story("2.", "High score story", 900)}${story("3.", "Mid score story", 100)}</tbody></table>`;
    const { applyChange } = await import("../extension/src/content/engine.js");
    const change: Change = {
      id: "sort-points",
      summary: "Sort stories by points, highest first",
      reason: "User asked to sort by number of points, highest first",
      scope: "page",
      css: null,
      dom: [{ op: "reorder", selector: "tr.athing", keySelector: "a", direction: "desc", ranking: null }],
      block: null,
    };
    const outcome = await applyChange(change, false);
    assert.equal(outcome.ok, true, outcome.error ?? "");
    const titles = [...document.querySelectorAll("tr.athing a")].map((node) => node.textContent);
    assert.deepEqual(titles, ["High score story", "Mid score story", "Low score story"]);
    for (const row of document.querySelectorAll("tr.athing")) {
      const title = row.querySelector("a")?.textContent ?? "";
      const points = row.nextElementSibling?.textContent ?? "";
      assert.match(points, /points/);
      if (title.startsWith("High")) assert.match(points, /900 points/);
      if (title.startsWith("Mid")) assert.match(points, /100 points/);
      if (title.startsWith("Low")) assert.match(points, /10 points/);
      assert.equal(row.nextElementSibling?.nextElementSibling?.classList.contains("spacer"), true);
    }
  });

  it("rejects a title ranking that does not put the highest points first", async () => {
    document.body.innerHTML = `<table><tbody>${story("1.", "Low score story", 10)}${story("2.", "High score story", 900)}${story("3.", "Mid score story", 100)}</tbody></table>`;
    const { applyChange } = await import("../extension/src/content/engine.js");
    const change: Change = {
      id: "sort-points-bad",
      summary: "Sort stories by points, highest first",
      reason: "User asked to sort by number of points, highest first",
      scope: "page",
      css: null,
      dom: [{
        op: "reorder",
        selector: "tr.athing",
        keySelector: "a",
        direction: "asc",
        ranking: [
          { key: "Low score story", rank: 1 },
          { key: "Mid score story", rank: 2 },
          { key: "High score story", rank: 3 },
        ],
      }],
      block: null,
    };
    const outcome = await applyChange(change, false);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /points are not in order/);
    assert.equal(document.querySelector("tr.athing a")?.textContent, "Low score story");
  });

  it("does not drag the next table row along when it is not a story subtext", async () => {
    document.body.innerHTML = `<table><tbody><tr class="row"><td>Bravo</td></tr><tr class="row"><td>Alpha</td></tr><tr class="note"><td>footnote</td></tr></tbody></table>`;
    const { applyChange } = await import("../extension/src/content/engine.js");
    const change: Change = {
      id: "sort-alpha",
      summary: "Sort the rows alphabetically",
      reason: "Alphabetical order",
      scope: "page",
      css: null,
      dom: [{ op: "reorder", selector: "tr.row", keySelector: "td", direction: "asc", ranking: null }],
      block: null,
    };
    const outcome = await applyChange(change, false);
    assert.equal(outcome.ok, true, outcome.error ?? "");
    const texts = [...document.querySelectorAll("tbody tr td")].map((node) => node.textContent);
    assert.deepEqual(texts, ["Alpha", "Bravo", "footnote"]);
  });
});

describe("contrast block", () => {
  it("fixes faint text in one change", async () => {
    document.body.innerHTML = `<p id="faint" style="color:rgb(204, 204, 204);background:rgb(255, 255, 255)">Hard to read</p><p id="ok" style="color:rgb(17, 17, 17);background:rgb(255, 255, 255)">Fine</p>`;
    const { applyChange } = await import("../extension/src/content/engine.js");
    const change: Change = {
      id: "contrast",
      summary: "Increase contrast",
      reason: "User asked to increase the contrast",
      scope: "page",
      css: null,
      dom: null,
      block: { name: "contrast", minRatio: 4.5 },
    };
    const outcome = await applyChange(change, false);
    assert.equal(outcome.ok, true, outcome.error ?? "");
    assert.equal(document.getElementById("faint")?.getAttribute("data-ba-contrast"), "ink");
    assert.equal(document.getElementById("ok")?.hasAttribute("data-ba-contrast"), false);
    assert.equal(document.getElementById("faint")?.style.getPropertyPriority("color"), "");
    const dark = document.createElement("p");
    dark.id = "dark";
    dark.textContent = "On a dark card";
    dark.style.color = "rgb(80, 80, 80)";
    dark.style.backgroundColor = "rgb(20, 20, 20)";
    document.body.append(dark);
    const { applyChange: again } = await import("../extension/src/content/engine.js");
    const second = await again({ ...change, id: "contrast-dark" }, false);
    assert.equal(second.ok, true, second.error ?? "");
    assert.equal(dark.getAttribute("data-ba-contrast"), "paper");
  });
});
