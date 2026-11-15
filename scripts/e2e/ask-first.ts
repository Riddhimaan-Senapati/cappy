import assert from "node:assert/strict";
import { openDemo, runE2E, shadowTextVisible, waitFor } from "./lib.js";

const runs = (output: string) => output.split("[run] page_load").length - 1;

// The default asks before adapting a new site: an offer appears and no model call runs until it is accepted.
await runE2E("ask-first", async ({ server, browser }) => {
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
  await worker.evaluate(() => chrome.storage.local.set({ paused: false, profile: ["Enjoys reading about science"] }));
  const settings = await worker.evaluate(() => chrome.storage.local.get(["proactive", "askBeforeAdapting"]));
  assert.notEqual(settings.askBeforeAdapting, false, "asking first is the default");

  const page = await openDemo(browser, "/demo/campus.html");
  await waitFor("the offer to adapt this page", () => shadowTextVisible(page, "Adapt this page to my needs"));
  await page.waitForTimeout(1_500);
  assert.equal(runs(server.output()), 0, "a page-load run started without being accepted");
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("ba-busy")), false, "the page was blurred while only offering");
});
