import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, Worker } from "playwright";
import { assert, getWorker, launchWithExtension, serveFixtures } from "./lib-e2e";

type CardStats = { podcastsShown: number; podcastTotal: number; othersHidden: number; latePodcastsShown: number; latePodcastTotal: number };

// A card counts as hidden when it or any ancestor is display:none, since a podcast-only shelf is hidden as one unit.
function readCardStats(page: Page): Promise<CardStats & { lateTotal: number }> {
  return page.evaluate(() => {
    const hiddenHere = (el: Element) => el.closest<HTMLElement>('[style*="display: none"]') !== null;
    const cards = [...document.querySelectorAll<HTMLElement>("ytd-rich-item-renderer")];
    const podcasts = cards.filter((c) => c.hasAttribute("data-podcast"));
    const others = cards.filter((c) => !c.hasAttribute("data-podcast"));
    const late = cards.filter((c) => c.hasAttribute("data-late"));
    const latePodcasts = late.filter((c) => c.hasAttribute("data-podcast"));
    return {
      podcastsShown: podcasts.filter((c) => !hiddenHere(c)).length,
      podcastTotal: podcasts.length,
      othersHidden: others.filter(hiddenHere).length,
      lateTotal: late.length,
      latePodcastsShown: latePodcasts.filter((c) => !hiddenHere(c)).length,
      latePodcastTotal: latePodcasts.length,
    };
  });
}

const PAGE_PORT = 5193;
const PAGE_PATH = "youtube.html";

// A standing rule needs no model call, so this runs without the backend.
const weekdayRule = {
  id: "e2e-weekday-podcasts",
  text: "hide podcasts on weekdays 9 to 5",
  sites: ["localhost"],
  everywhere: false,
  filter: {
    keywords: ["podcast", "podcasts", "episode"],
    action: "hide",
    schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
  },
  enabled: true,
  createdAt: 1,
};

const untilRule = {
  ...weekdayRule,
  id: "e2e-until-podcasts",
  text: "hide podcasts until December 15",
  filter: { keywords: ["podcast", "podcasts", "episode"], action: "hide", schedule: { until: "2026-12-15" } },
};

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

async function setClock(worker: Worker, iso: string | undefined): Promise<void> {
  await worker.evaluate(
    (value: string | undefined) =>
      value === undefined ? chrome.storage.local.remove("debugNow") : chrome.storage.local.set({ debugNow: value }),
    iso,
  );
}

async function setRules(worker: Worker, rules: unknown[]): Promise<void> {
  await worker.evaluate((value: unknown[]) => chrome.storage.local.set({ rules: value }), rules);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function expectPodcasts(page: Page, shown: boolean, label: string): Promise<void> {
  const ok = await waitFor(async () => {
    const s = await readCardStats(page);
    return shown ? s.podcastsShown === s.podcastTotal && s.podcastTotal > 0 : s.podcastsShown === 0 && s.podcastTotal > 0;
  }, 10_000);
  const s = await readCardStats(page);
  const containers = await page.evaluate(() =>
    ["content", "primary", "grid"].filter((id) => getComputedStyle(document.getElementById(id)!).display === "none"),
  );
  assert(containers.length === 0, `${label}: page containers stay visible (hidden: ${containers.join(", ") || "none"})`);
  assert(
    ok && s.othersHidden === 0,
    `${label}: podcast cards ${shown ? "visible" : "hidden"} (${s.podcastsShown}/${s.podcastTotal} shown, others hidden ${s.othersHidden})`,
  );
}

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);

  await setRules(worker, [weekdayRule]);
  await setClock(worker, at(2026, 11, 16, 10, 0));

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/${PAGE_PATH}`);
  await tab.waitForFunction(() => document.querySelectorAll("ytd-rich-item-renderer").length >= 28);
  const late = await waitFor(async () => (await readCardStats(tab)).lateTotal === 8, 10_000);
  assert(late, "page appended its 8 late cards");

  await expectPodcasts(tab, false, "Monday 10:00 is inside the weekday 9 to 5 window");

  await setClock(worker, at(2026, 11, 16, 18, 0));
  await expectPodcasts(tab, true, "Monday 18:00, after the window, without reload");

  await setClock(worker, at(2026, 11, 16, 10, 30));
  await expectPodcasts(tab, false, "Monday 10:30 returns to the window, without reload");

  await setClock(worker, at(2026, 11, 21, 10, 0));
  await expectPodcasts(tab, true, "Saturday 10:00 is a weekend, so the rule is paused");


  await setRules(worker, [untilRule]);
  await setClock(worker, at(2026, 12, 14, 10, 0));
  await expectPodcasts(tab, false, "Monday 2026-12-14 is before the until date 2026-12-15 (rule replaced)");

  await setClock(worker, at(2026, 12, 16, 10, 0));
  await expectPodcasts(tab, true, "2026-12-16 is after the until date, so podcasts are visible");

  await setRules(worker, []);
  await setClock(worker, at(2026, 12, 14, 10, 0));
  await Bun.sleep(1_000);
  await expectPodcasts(tab, true, "removing the rule shows podcasts again without reload");

  await tab.close();
  console.log("RULES PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  rmSync(userDataDir, { recursive: true, force: true });
}
