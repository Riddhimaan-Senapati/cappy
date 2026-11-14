import assert from "node:assert/strict";
import type { ActiveChange, Change } from "../../shared/adaptation.js";
import type { ApplyOutcome } from "../../shared/protocol.js";
import type { ContentRequest, ContentResponse } from "../../extension/src/messages.js";
import { clickShadowButton, fontSizeOf, openDemo, runE2E, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("verification", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const [worker] = browser.context.serviceWorkers();
  const demoId = await worker.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((candidate) => candidate.url === url);
    return tab?.id;
  }, demo.url());
  assert.ok(demoId !== undefined, "Demo tab is registered in Chromium");
  const tabId = demoId;

  async function apply(change: Change): Promise<ApplyOutcome> {
    return worker.evaluate(async ({ tabId, change }) => {
      const response: ContentResponse = await chrome.tabs.sendMessage(tabId, {
        kind: "tool", name: "apply_change", input: { change },
      } satisfies ContentRequest);
      if (!response.ok) throw new Error(response.error);
      return response.result as ApplyOutcome;
    }, { tabId, change });
  }

  const base: Change = {
    id: "verify-text", summary: "Larger test text", reason: "Request to make the page readable",
    scope: "site", css: "article p { font-size: 18px !important; }", dom: null, block: null,
  };
  assert.ok((await apply(base)).ok);
  assert.equal(await fontSizeOf(demo), 18);

  const rejected = await apply({ ...base, css: "article p { font-size: 8px !important; }" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? "", /The page was restored/);
  assert.equal(await fontSizeOf(demo), 18);
  const active = await worker.evaluate(async (id) => {
    const response: ContentResponse = await chrome.tabs.sendMessage(id, { kind: "list" } satisfies ContentRequest);
    if (!response.ok) throw new Error(response.error);
    return response.result as ActiveChange[];
  }, tabId);
  assert.equal(active.find((change) => change.id === base.id)?.css, base.css);

  await demo.bringToFront();
  await worker.evaluate(() => chrome.storage.local.set({ askBeforeRemember: true }));
  await worker.evaluate(async (id) => {
    await chrome.tabs.setZoom(id, 1.1);
    await chrome.tabs.setZoom(id, 1.25);
  }, tabId);
  await waitFor("the larger-text suggestion", () => shadowTextVisible(demo, "Make text bigger on every site?"));
  await clickShadowButton(demo, "Yes, remember");
  await waitFor("the saved larger-text preference", () => worker.evaluate(async () => {
    const { profile } = await chrome.storage.local.get("profile");
    return Array.isArray(profile) && profile.includes("Prefers larger text");
  }));

  await worker.evaluate(async (id) => {
    await chrome.storage.local.set({ askBeforeRemember: false, profile: [] });
    await chrome.tabs.setZoom(id, 1);
    await chrome.tabs.setZoom(id, 1.1);
    await chrome.tabs.setZoom(id, 1.25);
  }, tabId);
  await waitFor("automatic zoom memory", () => shadowTextVisible(demo, "Remembered that you prefer larger text on every site."));
  await waitFor("larger font after repeat zoom", async () => (await fontSizeOf(demo)) === 21.6);

  await clickShadowButton(demo, "Undo");
  await waitFor("the original font size after undo", async () => (await fontSizeOf(demo)) === 18);
  assert.equal(await worker.evaluate((id) => chrome.tabs.getZoom(id), tabId), 1.25);
});
