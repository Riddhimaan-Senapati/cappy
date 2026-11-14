import assert from "node:assert/strict";
import type { ActiveChange } from "../../shared/adaptation.js";
import { BASE_URL, openSidePanel, runE2E, sendChat, waitFor } from "./lib.js";

await runE2E("preferences", async ({ browser }) => {
  const firstOrigin = BASE_URL;
  const secondOrigin = BASE_URL.replace("localhost", "127.0.0.1");
  const pageContent = (cardTag: string) => `<!doctype html><main>
    <${cardTag}>Clickbait headline about the local park</${cardTag}>
    <${cardTag}>Sports roundup from Monday evening</${cardTag}>
    <${cardTag}>Community events and local meetings</${cardTag}>
  </main>`;
  await browser.context.route("**/preferences-test", (route) => {
    const cardTag = new URL(route.request().url()).origin === firstOrigin ? "news-card" : "feed-story";
    return route.fulfill({ contentType: "text/html", body: pageContent(cardTag) });
  });

  const [worker] = browser.context.serviceWorkers();
  const saved = (origin: string) => worker.evaluate(async (site) => {
    const { profile = [], siteChanges = {}, globalChanges = [] } = await chrome.storage.local.get(["profile", "siteChanges", "globalChanges"]) as {
      profile?: string[];
      siteChanges?: Record<string, ActiveChange[]>;
      globalChanges?: ActiveChange[];
    };
    return {
      profile,
      siteChanges: siteChanges[site] ?? [],
      globalChanges,
    };
  }, origin);

  const panel = await openSidePanel(browser);
  const firstSite = await browser.context.newPage();
  await firstSite.goto(`${firstOrigin}/preferences-test`);
  await sendChat(panel, firstSite, "I prefer larger text");
  await waitFor("larger text to be saved globally", async () =>
    (await saved(firstOrigin)).globalChanges.some(({ id }) => id === "bigger-text"),
  );

  await panel.getByText("Stub: made the text larger, saved that preference to your profile.", { exact: true }).waitFor();
  await sendChat(panel, firstSite, "remove clickbait");
  await panel.locator(".memory-choice", { hasText: "Hide clickbait" }).getByRole("button", { name: "All sites" }).click();
  await waitFor("the clickbait preference to be saved", async () =>
    (await saved(firstOrigin)).profile.includes("Hide clickbait"),
  );
  const firstFilter = await waitFor("a local clickbait filter on the first website", async () =>
    (await saved(firstOrigin)).siteChanges.find(({ id }) => id === "hide-clickbait"),
  );
  assert.match(firstFilter?.block?.name === "contentFilter" ? firstFilter.block.itemSelector ?? "" : "", /news-card/);

  await firstSite.goto(`${secondOrigin}/preferences-test`);
  await waitFor("global text scaling to restore", () => firstSite.locator('news-card, feed-story').last().evaluate(
    (card) => Number.parseFloat(getComputedStyle(card).fontSize) > 16,
  ));
  await waitFor("clickbait to be hidden on the second website", () => firstSite.locator("feed-story").first().isHidden());
  const secondFilter = await waitFor("a local clickbait filter on the second website", async () =>
    (await saved(secondOrigin)).siteChanges.find(({ id }) => id === "hide-clickbait"),
  );
  assert.match(secondFilter?.block?.name === "contentFilter" ? secondFilter.block.itemSelector ?? "" : "", /feed-story/);
  assert.ok(await firstSite.getByText("Sports roundup from Monday evening").isVisible());
});
