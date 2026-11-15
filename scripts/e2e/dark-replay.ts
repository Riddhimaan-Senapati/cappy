import assert from "node:assert/strict";
import type { ApplyOutcome } from "../../shared/protocol.js";
import type { ContentResponse } from "../../extension/src/messages.js";
import { openDemo, runE2E, waitFor } from "./lib.js";

const ORIGIN = "http://localhost:8787";
const DIM = "html, body { background: #111111 !important; color: #f5f5f5 !important; }";

await runE2E("dark-replay", async ({ browser, server }) => {
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
  await worker.evaluate(async ({ origin, css }) => {
    const change = (fields: Record<string, unknown>) => ({ css: null, dom: null, block: null, appliedAt: Date.now(), ...fields });
    await chrome.storage.local.set({
      proactive: false,
      paused: false,
      profile: [],
      darkModeStrategy: { localhost: "invert" },
      siteChanges: {
        [origin]: [change({
          id: "dim-page", summary: "Dim the page", reason: "dim this page", scope: "page", pagePath: "/demo/campus.html", css,
        })],
      },
      globalChanges: [change({
        id: "dark-mode", summary: "Dark mode", reason: "dark mode", scope: "everywhere",
        block: { name: "darkMode", allowSiteControls: true },
      })],
    });
  }, { origin: ORIGIN, css: DIM });

  const look = (page: Awaited<ReturnType<typeof openDemo>>) => page.evaluate(() => ({
    filter: getComputedStyle(document.documentElement).filter,
    background: getComputedStyle(document.body).backgroundColor,
  }));

  const campus = await openDemo(browser, "/demo/campus.html");
  await waitFor("saved dim and dark mode to settle", async () => {
    const paint = await look(campus);
    return paint.background === "rgb(17, 17, 17)" ? paint : undefined;
  });
  assert.equal((await look(campus)).filter, "none", "replay inverted an already-dark page");

  const again = await openDemo(browser, "/demo/campus.html");
  await waitFor("the same look in a new tab", async () => (await look(again)).background === "rgb(17, 17, 17)");
  assert.equal((await look(again)).filter, "none");
  await campus.reload();
  await waitFor("the same look after reload", async () => (await look(campus)).background === "rgb(17, 17, 17)");
  assert.equal((await look(campus)).filter, "none");
  assert.equal(server.output().includes("[run]"), false, "replaying saved changes called the model");

  await worker.evaluate(() => chrome.storage.local.set({ globalChanges: [] }));
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, campus.url());
  assert.ok(tabId !== undefined);
  const outcome = await worker.evaluate(async (id) => {
    const response: ContentResponse = await chrome.tabs.sendMessage(id, {
      kind: "tool",
      name: "apply_change",
      input: {
        change: {
          id: "dark-mode", summary: "Dark mode", reason: "dark mode", scope: "everywhere", css: null, dom: null,
          block: { name: "darkMode", allowSiteControls: true },
        },
      },
    });
    if (!response.ok) throw new Error(response.error);
    return response.result as ApplyOutcome;
  }, tabId);
  assert.equal(outcome.noop, true);
  assert.match(outcome.note ?? "", /already dark/);
  assert.equal((await look(campus)).filter, "none");
  const saved = await worker.evaluate(async () => ((await chrome.storage.local.get("globalChanges")) as { globalChanges?: Array<{ id: string }> }).globalChanges ?? []);
  assert.equal(saved.some((change) => change.id === "dark-mode"), false, "a no-op dark mode was saved for every site");
});
