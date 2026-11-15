import assert from "node:assert/strict";
import { askInBar, fontSizeOf, openDemo, openSidePanel, runE2E, sendChat, shadowTextVisible, waitFor } from "./lib.js";

const ORIGIN = "http://localhost:8787";
const REQUEST = "make the text bigger";

await runE2E("replay-trap", async ({ browser }) => {
  const campus = await openDemo(browser, "/demo/campus.html");
  const panel = await openSidePanel(browser);
  const campusBefore = await fontSizeOf(campus);
  await sendChat(panel, campus, REQUEST);
  await waitFor("paragraph font-size to grow", async () => ((await fontSizeOf(campus)) >= campusBefore * 1.25 ? true : undefined));

  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
  await waitFor("the recipe and the site change to be saved", () =>
    worker.evaluate(async (origin) => {
      const data = await chrome.storage.local.get(["recipes", "siteChanges"]);
      const recipes = data.recipes as Record<string, unknown> | undefined;
      const site = data.siteChanges as Record<string, unknown[]> | undefined;
      return recipes?.[`${origin}::make the text bigger`] && site?.[origin]?.length ? true : undefined;
    }, ORIGIN),
  );

  const trap = await openDemo(browser, "/demo/trap.html");
  const before = await fontSizeOf(trap, "li");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const size = await fontSizeOf(trap, "li");
    const marks = await trap.evaluate(() => document.querySelectorAll('[data-ba^="change:"]').length);
    assert.ok(Math.abs(size - before) <= 0.5, `saved changes enlarged trap text on load (${size}px, was ${before}px)`);
    assert.equal(marks, 0, "saved changes left a style on the trap page");
    await trap.waitForTimeout(200);
  }

  await askInBar(trap, REQUEST);
  await waitFor("the bar to say the page was blocked", () => shadowTextVisible(trap, "Blocked."));
  assert.equal(await shadowTextVisible(trap, "from your saved version"), false);
  assert.equal(await fontSizeOf(trap, "li"), before, "replaying the saved request changed the trap page");
  assert.equal(await trap.evaluate(() => document.querySelectorAll('[data-ba^="change:"]').length), 0);
});
