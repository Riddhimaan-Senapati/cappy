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
  it("moves the title, subtext, and spacer as one group, highest points first", async () => {
    document.body.innerHTML = `<table><tbody>${story("1.", "Low score story", 10)}${story("2.", "High score story", 900)}${story("3.", "Mid score story", 100)}</tbody></table>`;
    const { applyChange } = await import("../extension/src/content/engine.js");
    const change: Change = {
      id: "sort-points",
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
    assert.equal(outcome.ok, true, outcome.error ?? "");
    const titles = [...document.querySelectorAll("tr.athing a")].map((node) => node.textContent);
    assert.deepEqual(titles, ["High score story", "Mid score story", "Low score story"]);
    for (const row of document.querySelectorAll("tr.athing")) {
      const title = row.querySelector("a")?.textContent ?? "";
      const points = row.nextElementSibling?.textContent ?? "";
      assert.match(points, /points/);
      assert.equal(points.includes(title.split(" ")[0]!), false);
      if (title.startsWith("High")) assert.match(points, /900 points/);
      if (title.startsWith("Mid")) assert.match(points, /100 points/);
      if (title.startsWith("Low")) assert.match(points, /10 points/);
      assert.equal(row.nextElementSibling?.nextElementSibling?.classList.contains("spacer"), true);
    }
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
    assert.equal(document.getElementById("faint")?.style.color.replace(/\s/g, ""), "#141414");
    assert.equal(document.getElementById("ok")?.style.color.replace(/\s/g, ""), "rgb(17,17,17)");
    assert.match(outcome.note ?? "", /Raised contrast on 1/);
  });
});
