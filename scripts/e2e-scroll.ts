import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  BACKEND_PORT,
  assert,
  extensionIdFrom,
  getWorker,
  launchWithExtension,
  requestBox,
  requestSendButton,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5192;
const REQUEST = "remove all podcasts";
const BATCHES = 12;
const BATCH_SIZE = 6;

// A card counts as hidden when it or any ancestor is display:none, since a podcast-only shelf is hidden as one unit.
function readCardStats(page: Page): Promise<{ podcastsShown: number; podcastTotal: number; othersHidden: number }> {
  return page.evaluate(() => {
    const hiddenHere = (el: Element) => el.closest<HTMLElement>('[style*="display: none"]') !== null;
    const cards = [...document.querySelectorAll<HTMLElement>("ytd-rich-item-renderer")];
    const podcasts = cards.filter((c) => c.hasAttribute("data-podcast"));
    return {
      podcastsShown: podcasts.filter((c) => !hiddenHere(c)).length,
      podcastTotal: podcasts.length,
      othersHidden: cards.filter((c) => !c.hasAttribute("data-podcast") && hiddenHere(c)).length,
    };
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return false;
}

// Appends a batch the way an infinite-scroll feed does: several cards, some podcasts, far down the grid.
function appendBatch(page: Page, batch: number, size: number): Promise<void> {
  return page.evaluate(
    ({ batch, size }) => {
      const grid = document.getElementById("grid")!;
      const cards = Array.from({ length: size }, (_, i) => {
        const n = batch * size + i;
        const podcast = n % 2 === 0;
        const title = podcast ? `Feed podcast ${n} for the scroll test` : `Feed video ${n} about gardening`;
        const attrs = podcast ? ` data-podcast="true" aria-label="${title}"` : "";
        return `<ytd-rich-item-renderer class="item" data-batch="${batch}"${attrs}><div class="thumb"></div><h3 id="video-title">${title}</h3><a class="channel" href="#">Feed ${n}</a><span class="meta">${podcast ? "Podcast" : "Video"} · just now</span></ytd-rich-item-renderer>`;
      });
      grid.insertAdjacentHTML("beforeend", cards.join(""));
    },
    { batch, size },
  );
}

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  // An empty key makes the backend use its offline stub requester.
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);
  await seedProfile(context, { version: 0, summary: "", needs: [] });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/youtube.html`);
  await tab.waitForFunction(() => document.querySelectorAll("ytd-rich-item-renderer").length >= 28);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`);
  await (await requestBox(panel)).fill(REQUEST);
  await tab.bringToFront();
  await (await requestSendButton(panel)).click();

  const hidden = await waitFor(async () => {
    const s = await readCardStats(tab);
    return s.podcastsShown === 0 && s.othersHidden === 0;
  }, 20_000);
  const first = await readCardStats(tab);
  assert(hidden, `"${REQUEST}" hides the podcast cards before scrolling (${first.podcastsShown}/${first.podcastTotal} shown)`);

  let scrolled = 0;
  for (let batch = 0; batch < BATCHES; batch++) {
    await tab.mouse.wheel(0, 4000);
    await Bun.sleep(150);
    await appendBatch(tab, batch, BATCH_SIZE);
    await Bun.sleep(250);
    const y = await tab.evaluate(() => window.scrollY);
    if (y > 0) scrolled += 1;
  }
  await Bun.sleep(1_000);

  const after = await readCardStats(tab);
  const feed = await tab.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>("[data-batch]")];
    const shown = (el: HTMLElement) => el.closest('[style*="display: none"]') === null;
    const podcasts = cards.filter((c) => c.hasAttribute("data-podcast"));
    return {
      total: cards.length,
      podcastTotal: podcasts.length,
      podcastsShown: podcasts.filter(shown).length,
      othersShown: cards.filter((c) => !c.hasAttribute("data-podcast") && shown(c)).length,
      othersTotal: cards.filter((c) => !c.hasAttribute("data-podcast")).length,
    };
  });
  assert(feed.total === BATCHES * BATCH_SIZE, `all ${BATCHES} scroll batches were appended (${feed.total} cards)`);
  assert(feed.podcastsShown === 0 && feed.podcastTotal > 0, `every appended podcast card stays hidden (${feed.podcastsShown} shown of ${feed.podcastTotal})`);
  assert(feed.othersShown === feed.othersTotal, `appended non-podcast cards stay visible (${feed.othersShown}/${feed.othersTotal})`);
  assert(after.podcastsShown === 0 && after.othersHidden === 0, "original cards stay filtered after scrolling");
  console.log(`scrolled ${scrolled}/${BATCHES} times, final scrollY ${await tab.evaluate(() => Math.round(window.scrollY))}`);
  await tab.close();
  await panel.close();
  console.log("SCROLL PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
