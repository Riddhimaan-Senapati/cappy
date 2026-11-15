import assert from "node:assert/strict";
import type { ActiveChange, Change } from "../../shared/adaptation.js";
import type { ApplyOutcome } from "../../shared/protocol.js";
import type { ContentRequest, ContentResponse } from "../../extension/src/messages.js";
import { clickShadowButton, fontSizeOf, openDemo, runE2E, shadowButtonVisible, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("verification", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const [worker] = browser.context.serviceWorkers();
  const demoId = await worker.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((candidate) => candidate.url === url);
    return tab?.id;
  }, demo.url());
  assert.ok(demoId !== undefined, "Demo tab is registered in Chromium");
  const tabId = demoId;

  async function apply(change: Change, requested = false): Promise<ApplyOutcome> {
    return worker.evaluate(async ({ tabId, change, requested }) => {
      const response: ContentResponse = await chrome.tabs.sendMessage(tabId, {
        kind: "tool", name: "apply_change", input: { change }, ...(requested ? { requested: true } : {}),
      } satisfies ContentRequest);
      if (!response.ok) throw new Error(response.error);
      return response.result as ApplyOutcome;
    }, { tabId, change, requested });
  }

  const base: Change = {
    id: "verify-text", summary: "Larger test text", reason: "Request to make the page readable",
    scope: "site", css: "article p { font-size: 18px !important; }", dom: null, block: null,
  };
  const beforeScale = await fontSizeOf(demo);
  const scaled = await apply({
    id: "scale-over", summary: "Larger text", reason: "Text scale is on",
    scope: "page", css: null, dom: null, block: { name: "textScale", scale: 1.3 },
  });
  assert.equal(scaled.ok, true);
  assert.ok((await fontSizeOf(demo)) >= beforeScale * 1.25, "text scale enlarged the paragraph");
  const overScale = await apply({
    id: "shrink-probe", summary: "Tiny text", reason: "Request to try a smaller size",
    scope: "page", css: "article p { font-size: 8px !important; }", dom: null, block: null,
  }, true);
  assert.equal(overScale.ok, true, "a requested font-size change is kept while text scale is on");
  assert.ok((overScale.worsened ?? 0) > 0, "font-size CSS overrides text scale and the rise is reported");
  assert.equal(await fontSizeOf(demo), 8);
  await worker.evaluate(async (id) => {
    for (const changeId of ["shrink-probe", "scale-over"]) {
      const response: ContentResponse = await chrome.tabs.sendMessage(id, { kind: "tool", name: "revert_change", input: { id: changeId } });
      if (!response.ok) throw new Error(response.error);
    }
  }, tabId);
  assert.equal(await fontSizeOf(demo), beforeScale);

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


  const zoomTwice = () => worker.evaluate(async (id) => {
    await chrome.tabs.setZoom(id, 1);
    await chrome.tabs.setZoom(id, 1.1);
    await chrome.tabs.setZoom(id, 1.25);
  }, tabId);
  const feedback = () => worker.evaluate(async () => {
    const { suggestionFeedback = [] } = await chrome.storage.local.get("suggestionFeedback") as { suggestionFeedback?: Array<{ outcome: string }> };
    return suggestionFeedback.map(({ outcome }) => outcome);
  });

  await demo.bringToFront();
  await zoomTwice();
  await waitFor("the noticed-friction suggestion", () => shadowButtonVisible(demo, "make the text bigger"));
  await clickShadowButton(demo, "make the text bigger");
  await waitFor("larger text from the accepted suggestion", async () => (await fontSizeOf(demo)) > 18);
  await waitFor("the scope prompt for the preference", () => shadowTextVisible(demo, "Save this preference? Prefers larger text"));
  await clickShadowButton(demo, "All sites");
  await waitFor("the saved larger-text preference", () => worker.evaluate(async () => {
    const { profile } = await chrome.storage.local.get("profile");
    return Array.isArray(profile) && profile.includes("Prefers larger text");
  }));
  assert.deepEqual(await feedback(), ["accepted"]);

  await worker.evaluate(() => chrome.storage.local.set({ profile: [], pendingMemory: [], pendingSites: {}, frictionLog: [], nudgedAt: {} }));
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { kind: "tool", name: "revert_change", input: { id: "bigger-text" } }), tabId);
  await waitFor("the original font size before the second round", async () => (await fontSizeOf(demo)) === 18);
  await zoomTwice();
  await waitFor("the suggestion again", () => shadowButtonVisible(demo, "make the text bigger"));
  await clickShadowButton(demo, "make the text bigger");
  await waitFor("the second suggestion to enlarge the text", async () => (await fontSizeOf(demo)) > 18);
  await waitFor("the combined undo and scope prompt", () => shadowTextVisible(demo, "Save this preference? Prefers larger text"));
  await clickShadowButton(demo, "Undo");
  await waitFor("the original font size after a quick undo", async () => (await fontSizeOf(demo)) === 18);
  await waitFor("the quick undo recorded as feedback", async () => (await feedback()).includes("undone"));
  assert.equal(await worker.evaluate((id) => chrome.tabs.getZoom(id), tabId), 1.25);
  const requested = await worker.evaluate(async ({ tabId, change }) => {
    const response: ContentResponse = await chrome.tabs.sendMessage(tabId, {
      kind: "tool", name: "apply_change", input: { change }, requested: true,
    } satisfies ContentRequest);
    if (!response.ok) throw new Error(response.error);
    return response.result as ApplyOutcome;
  }, { tabId, change: { ...base, css: "article p { font-size: 8px !important; }" } });
  assert.equal(requested.ok, true, "a change the user asked for is kept even when problem counts rise");
  assert.ok((requested.worsened ?? 0) > 0, "the rise is reported to the model");
  assert.equal(await fontSizeOf(demo), 8);
});
