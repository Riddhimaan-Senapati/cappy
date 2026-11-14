import assert from "node:assert/strict";
import { openDemo, openSidePanel, runE2E, sendChat, waitFor } from "./lib.js";

await runE2E("history", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const panel = await openSidePanel(browser);
  await sendChat(panel, demo, "remove clickbait");
  await waitFor("the saved request", () => panel.evaluate(async () => {
    const { submittedRequests } = await chrome.storage.local.get("submittedRequests");
    return Array.isArray(submittedRequests) && submittedRequests.includes("remove clickbait");
  }));
  await panel.reload();
  await panel.locator("textarea").fill("remvoe clickbait");
  await panel.getByRole("button", { name: "remove clickbait", exact: true }).click();
  assert.equal(await panel.locator("textarea").inputValue(), "remove clickbait");
  await panel.locator("textarea").fill("remove clickbait only here");
  assert.equal(await panel.locator("textarea").inputValue(), "remove clickbait only here");
});
