import assert from "node:assert/strict";
import { runE2E } from "./lib.js";

await runE2E("welcome-focus", async ({ browser }) => {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/welcome.html`);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: /^(Continue|Skip for now)$/ }).click();
  await page.getByRole("heading", { level: 1 }).waitFor();
  const need = page.locator(".w-need").first();
  await need.focus();
  const name = await need.textContent();
  await need.click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => document.activeElement?.textContent ?? "");
  assert.equal(after, name, "focus stays on the toggled need card");
});
