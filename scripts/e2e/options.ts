import assert from "node:assert/strict";
import { fontSizeOf, openDemo, openSidePanel, runE2E, sendChat, waitFor } from "./lib.js";

await runE2E("options", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const panel = await openSidePanel(browser);
  const before = await fontSizeOf(demo);
  await sendChat(panel, demo, "make this easier to read");
  const choice = panel.locator(".memory-choice", { hasText: "Which would help most?" });
  await choice.getByRole("button", { name: "Larger text", exact: true }).waitFor();
  assert.equal(await choice.getByRole("button", { name: /^Edit option/ }).count(), 3);

  await choice.getByRole("button", { name: "Edit option: Larger text" }).click();
  assert.equal(await panel.locator("textarea").inputValue(), "make the text bigger");

  await choice.getByRole("button", { name: "Larger text", exact: true }).click();
  await waitFor("larger text from the picked option", async () => (await fontSizeOf(demo)) > before);
  await waitFor("the options saved with the session", () => panel.evaluate(async () => {
    const { requestSessions = [] } = await chrome.storage.local.get("requestSessions") as { requestSessions?: Array<{ message: string; options?: { options: unknown[] } }> };
    return requestSessions.some((session) => session.message === "make this easier to read" && session.options?.options.length === 3);
  }));
});
