import assert from "node:assert/strict";
import { clickShadowButton, openDemo, openSidePanel, fontSizeOf, runE2E, sendChat, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("gate", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const panel = await openSidePanel(browser);
  const before = await fontSizeOf(demo);

  await sendChat(panel, demo, "make the text bigger");
  await waitFor("the agent reply in the side panel", () => panel.locator(".run .reply").first().textContent({ timeout: 500 }).catch(() => null));
  const after = await waitFor("paragraph font-size to grow", async () => {
    const size = await fontSizeOf(demo);
    return size >= before * 1.25 ? size : undefined;
  });
  assert.ok(after / before >= 1.25, `font-size ${before}px -> ${after}px is less than 25% growth`);

  await waitFor("the Undo button in the page toast", () => shadowTextVisible(demo, "Undo"));
  await clickShadowButton(demo, "Undo");
  const restored = await waitFor("paragraph font-size to return", async () => {
    const size = await fontSizeOf(demo);
    return Math.abs(size - before) < 0.5 ? size : undefined;
  });
  assert.ok(Math.abs(restored - before) < 0.5, `Undo left font-size at ${restored}px, expected ${before}px`);
});
