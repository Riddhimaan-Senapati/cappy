import assert from "node:assert/strict";
import type { SiteControl, SiteControlOutcome } from "../../shared/protocol.js";
import { clickShadowButton, openDemo, openSidePanel, runE2E, sendChat, shadowTextVisible, waitFor } from "./lib.js";

await runE2E("site-controls", async ({ browser }) => {
  await browser.context.route("http://localhost:8787/demo/site-controls.html", (route) => route.fulfill({
    contentType: "text/html",
    body: `<title>Display preferences</title>
      <button id="theme" type="button" aria-pressed="false">Dark mode</button>
      <label for="order">Sort by</label>
      <select id="order"><option>Oldest</option><option>Newest</option></select>
      <form><button type="button" aria-pressed="false">Dark mode</button></form>
      <button type="button" aria-pressed="false">Account settings</button>
      <script>
        const theme = document.querySelector('#theme');
        theme.addEventListener('click', () => {
          const on = theme.getAttribute('aria-pressed') === 'false';
          theme.setAttribute('aria-pressed', String(on));
          document.body.style.background = on ? '#111' : '#fff';
        });
        const order = document.querySelector('#order');
        order.addEventListener('change', () => document.body.dataset.order = order.value);
      </script>`,
  }));
  const demo = await openDemo(browser, "/demo/site-controls.html");
  const panel = await openSidePanel(browser);
  const tab = await panel.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost:8787/demo/site-controls.html" }))[0].id!);
  const controls = await panel.evaluate(async (id) =>
    (await chrome.tabs.sendMessage(id, { kind: "tool", name: "find_site_features", input: {} })).result as SiteControl[], tab);
  assert.deepEqual(controls.map(({ name }) => name), ["Dark mode", "Sort by"]);
  const [theme, sort] = controls;
  const use = async (control: SiteControl, value: boolean | number, userMessage: string): Promise<SiteControlOutcome> =>
    panel.evaluate(async ({ tab, input, userMessage }) => (await chrome.tabs.sendMessage(tab, { kind: "useSiteControl", input, userMessage })).result,
      { tab, input: { controlId: control.id, value, summary: "Use site preference", reason: "Requested in chat" }, userMessage });
  assert.equal((await use(theme, true, "make this page easier to read")).status, "unavailable");
  assert.equal(await demo.locator("#theme").getAttribute("aria-pressed"), "false");
  assert.equal((await use(sort, 1, "set sort by to oldest")).status, "unavailable");
  const changed = await use(sort, 1, "set sort by to newest");
  assert.equal(changed.status, "applied");
  assert.equal(await demo.locator("body").getAttribute("data-order"), "Newest");
  if (changed.status === "applied") {
    await panel.evaluate(async ({ tab, id }) => chrome.tabs.sendMessage(tab, { kind: "tool", name: "revert_change", input: { id } }), { tab, id: changed.change.id });
    assert.equal(await demo.locator("body").getAttribute("data-order"), "Oldest");
  }
  await sendChat(panel, demo, "turn on dark mode");
  await waitFor("native dark mode to turn on", async () => (await demo.locator("#theme").getAttribute("aria-pressed")) === "true");
  await waitFor("a site control Undo action", () => shadowTextVisible(demo, "Undo"));
  await clickShadowButton(demo, "Undo");
  await waitFor("native dark mode to turn off", async () => (await demo.locator("#theme").getAttribute("aria-pressed")) === "false");
});
