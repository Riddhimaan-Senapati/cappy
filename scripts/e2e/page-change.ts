import assert from "node:assert/strict";
import { askInBar, fontSizeOf, openDemo, runE2E } from "./lib.js";

// The stub waits before it applies anything, so the page can be replaced while the run is in flight.
process.env.STUB_DELAY_MS = "2000";

await runE2E("page-change", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const before = await fontSizeOf(demo);
  await askInBar(demo, "make the text bigger");
  await demo.waitForTimeout(600);
  await demo.reload();
  await demo.waitForLoadState("load");
  await demo.waitForTimeout(4000);
  assert.equal(await fontSizeOf(demo), before, "a run started on the old page must not change the new one");
});
