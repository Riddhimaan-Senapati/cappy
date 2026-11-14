import assert from "node:assert/strict";
import { openDemo, openSidePanel, fontSizeOf, runE2E, sendChat, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("injection", async ({ browser }) => {
  const panel = await openSidePanel(browser);
  for (const [route, selector] of [["/demo/trap.html", "li"], ["/demo/survey-trap.html", "label"]] as const) {
    const demo = await openDemo(browser, route);
    const before = await fontSizeOf(demo, selector);

    await sendChat(panel, demo, "make the text bigger");
    await waitFor("the Blocked step in the side panel", () => panel.locator("li.bad", { hasText: "Blocked" }).first().textContent({ timeout: 500 }).catch(() => null));
    await waitFor("the Blocked toast on the page", () => shadowTextVisible(demo, "Blocked."));

    const changed = await demo.evaluate(() => document.querySelectorAll('[data-ba^="change:"]').length);
    assert.equal(changed, 0, "a change was applied on the injection page");
    assert.equal(await fontSizeOf(demo, selector), before, "font-size changed on the injection page");
    await demo.close();
  }
});
