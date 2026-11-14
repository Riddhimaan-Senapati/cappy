import assert from "node:assert/strict";
import { openDemo, openSidePanel, runE2E, sendChat, waitFor } from "./lib.js";

await runE2E("history", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const panel = await openSidePanel(browser);
  await sendChat(panel, demo, "remove clickbait");
  await waitFor("the saved request", () => panel.evaluate(async () => {
    const { requestSessions } = await chrome.storage.local.get("requestSessions");
    return Array.isArray(requestSessions) && requestSessions.some((session) => session.message === "remove clickbait");
  }));
  await panel.reload();
  await panel.locator("textarea").fill("remvoe clickbait");
  await panel.getByRole("button", { name: "remove clickbait", exact: true }).click();
  await panel.getByText("Request history", { exact: true }).waitFor();
  assert.equal(await panel.locator("textarea").inputValue(), "remvoe clickbait");
  await panel.getByRole("button", { name: "Use request again" }).click();
  assert.equal(await panel.locator("textarea").inputValue(), "remove clickbait");
  await panel.locator("textarea").fill("remove clickbait only here");
  assert.equal(await panel.locator("textarea").inputValue(), "remove clickbait only here");
});
