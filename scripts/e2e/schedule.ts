import assert from "node:assert/strict";
import { openDemo, openSidePanel, runE2E, sendChat, shadowClassShown, shadowTextVisible, waitFor } from "./lib.js";

const hhmm = (offsetHours: number) => {
  const at = new Date(Date.now() + offsetHours * 3_600_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

// Evolve-style time rules: hide matching items only during a time window, and say whether the rule is on.
await runE2E("schedule", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/youtube.html");
  const panel = await openSidePanel(browser);
  const podcast = demo.locator("[data-podcast]").first();
  const short = demo.locator("[data-shorts]").first();
  assert.ok(await podcast.isVisible() && await short.isVisible());

  await sendChat(panel, demo, `hide podcasts between ${hhmm(-1)} and ${hhmm(1)}`);
  await waitFor("podcasts hidden while their window is open", () => podcast.isHidden());

  await sendChat(panel, demo, `hide shorts between ${hhmm(2)} and ${hhmm(3)}`);
  const [worker] = browser.context.serviceWorkers();
  await waitFor("the shorts rule saved with its schedule", () => worker.evaluate(async () => {
    type Saved = Array<{ id: string; schedule?: unknown }>;
    const { siteChanges = {}, globalChanges = [] } = await chrome.storage.local.get(["siteChanges", "globalChanges"]) as { siteChanges?: Record<string, Saved>; globalChanges?: Saved };
    return [...Object.values(siteChanges).flat(), ...globalChanges].some((change) => change.id === "hide-shorts" && change.schedule);
  }));
  await demo.waitForTimeout(500);
  assert.ok(await short.isVisible(), "shorts stay visible outside their window");

  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8787/demo/youtube.html" }))[0]?.id);
  await demo.bringToFront();
  await worker.evaluate((id) => chrome.tabs.sendMessage(id!, { kind: "toggleSpotlight" }), tabId);
  await demo.waitForTimeout(600);
  await waitFor("the bar marking focus while a timed rule is on", () => shadowClassShown(demo, "focus-tag"));
  await demo.keyboard.press("ArrowRight");
  await waitFor("change history saying the podcast rule is on", () => shadowTextVisible(demo, "on now"));
  await waitFor("change history saying the shorts rule is off", () => shadowTextVisible(demo, "off right now"));

  await sendChat(panel, demo, "don't show shorts for the next 8 seconds");
  await waitFor("shorts hidden for the short span", () => short.isHidden());
  await waitFor("shorts return when the span ends", () => short.isVisible(), 15_000);
});
