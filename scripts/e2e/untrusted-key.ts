import assert from "node:assert/strict";
import { openBar } from "./bar.js";
import { fontSizeOf, openDemo, runE2E } from "./lib.js";

await runE2E("untrusted-key", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const before = await fontSizeOf(demo);
  await openBar(demo);
  await demo.keyboard.type("make the text bigger");
  // A page script can fire key events at the open bar, and none of them may submit it.
  await demo.evaluate(() => {
    const send = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    send(document.activeElement ?? document.body);
    send(document);
    send(window);
  });
  await demo.waitForTimeout(1500);
  assert.equal(await fontSizeOf(demo), before, "a synthetic Enter must not run the request");
  await demo.keyboard.press("Enter");
  const deadline = Date.now() + 15_000;
  while ((await fontSizeOf(demo)) <= before) {
    assert.ok(Date.now() < deadline, "a real Enter should run the request");
    await demo.waitForTimeout(100);
  }
});
