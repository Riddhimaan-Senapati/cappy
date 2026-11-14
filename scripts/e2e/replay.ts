import assert from "node:assert/strict";
import { openDemo, openSidePanel, fontSizeOf, runE2E, sendChat, serveDemoFromDisk, waitFor } from "./lib.js";

await runE2E("replay", async ({ browser, server }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const panel = await openSidePanel(browser);
  const before = await fontSizeOf(demo);

  await sendChat(panel, demo, "make the text bigger");
  await waitFor("paragraph font-size to grow", async () => ((await fontSizeOf(demo)) >= before * 1.25 ? true : undefined));

  await server.stop();
  await serveDemoFromDisk(browser);
  await demo.reload();
  await demo.waitForLoadState("load");
  const replayed = await waitFor("saved change to replay after reload", async () => {
    const size = await fontSizeOf(demo);
    return size >= before * 1.25 ? size : undefined;
  });
  assert.ok(replayed / before >= 1.25, `replayed font-size ${replayed}px is not larger than ${before}px`);
});
