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
  assert.equal(await panel.locator("textarea").inputValue(), "");
  await panel.getByRole("button", { name: "Use request again" }).click();
  assert.equal(await panel.locator("textarea").inputValue(), "remove clickbait");
  const followUp = "remove clickbait only here";
  await sendChat(panel, demo, followUp);
  await waitFor("the follow-up saved in the original session", () => panel.evaluate(async (message) => {
    const { requestSessions } = await chrome.storage.local.get("requestSessions");
    return Array.isArray(requestSessions) && requestSessions.some((session) =>
      session.message === message && session.thread === "remove clickbait" && session.outcome === "done",
    );
  }, followUp));
});
