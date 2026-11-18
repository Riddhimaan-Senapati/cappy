import { openBar } from "./bar.js";
import { askInBar, fontSizeOf, openDemo, runE2E, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("undo-key", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const before = await fontSizeOf(demo);
  await askInBar(demo, "make the text bigger");
  await waitFor("larger text", async () => (await fontSizeOf(demo)) > before);
  await demo.reload();
  await waitFor("saved change replayed", async () => (await fontSizeOf(demo)) > before);
  await openBar(demo);
  await waitFor("the Undo row in the bar", () => shadowTextVisible(demo, "Undo "));
  await demo.keyboard.press("ArrowDown");
  await demo.keyboard.press("Enter");
  await waitFor("keyboard undo", async () => Math.abs((await fontSizeOf(demo)) - before) < 0.5);
});
