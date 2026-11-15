import assert from "node:assert/strict";
import { openDemo, runE2E, waitFor } from "./lib.js";

const runs = (output: string) => output.split("[run] page_load").length - 1;

// The page-load run checks a site once per profile, then later tabs and visits reuse that check with no model call.
await runE2E("page-load", async ({ server, browser }) => {
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
  await worker.evaluate(() => chrome.storage.local.set({ proactive: true, paused: false, profile: ["Enjoys reading about science"] }));

  const first = await openDemo(browser, "/demo/campus.html");
  await waitFor("one page-load run on the first visit", async () => runs(server.output()) === 1);
  await waitFor("the site saved as checked for this profile", () =>
    worker.evaluate(async () => Object.keys(((await chrome.storage.local.get("proactiveChecked")) as { proactiveChecked?: object }).proactiveChecked ?? {}).length > 0),
  );
  await waitFor("the blur lifted", () => first.evaluate(() => !document.documentElement.classList.contains("ba-busy")), 3_000);

  const second = await openDemo(browser, "/demo/campus.html");
  await second.waitForTimeout(2_000);
  assert.equal(runs(server.output()), 1, "a new tab on a checked site made another model call");
  assert.equal(await second.evaluate(() => document.documentElement.classList.contains("ba-busy")), false, "a checked site was blurred");

  await worker.evaluate(() => chrome.storage.local.set({ profile: ["Enjoys reading about science", "Likes plain fonts"] }));
  await openDemo(browser, "/demo/campus.html");
  await waitFor("a changed profile checking the site again", async () => runs(server.output()) === 2);
});
