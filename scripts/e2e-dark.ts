import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, Worker } from "playwright";
import {
  BACKEND_PORT,
  assert,
  getWorker,
  launchWithExtension,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5195;
const HOST = "localhost";
const STRATEGY_KEY = "darkModeStrategy";

type Strategy = "class" | "media" | "toggle" | "invert";

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-dark-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

// The background restores a saved change for the host without a model call; this is the dark_mode entry.
async function seedSavedDark(worker: Worker): Promise<void> {
  const entry = {
    adaptation: {
      id: "e2e-dark-mode",
      sites: [HOST],
      reason: { text: "Dark mode for you", needId: "n1" },
      blocks: [{ block: "dark_mode", allowSiteControls: true }],
    },
    profileVersion: 1,
    savedAt: Date.now(),
  };
  await worker.evaluate(
    (saved: unknown) => chrome.storage.local.set({ savedChanges: saved }),
    { [HOST]: entry },
  );
  await worker.evaluate((key: string) => chrome.storage.local.remove(key), STRATEGY_KEY);
}

// The page's rendered color, not its computed style, so the invert filter is judged by what the user sees.
async function renderedLuma(tab: Page): Promise<number> {
  const png = await tab.screenshot({ clip: { x: 1, y: 400, width: 4, height: 4 } });
  return tab.evaluate(async (src: string) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      count++;
    }
    return sum / count;
  }, `data:image/png;base64,${png.toString("base64")}`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return false;
}

type PageFacts = {
  htmlDarkClass: boolean;
  zzNight: boolean;
  dataBaStyle: string | undefined;
  rootFilter: string;
  rootColorScheme: string;
  mainBackground: string;
};

function factsOf(tab: Page): Promise<PageFacts> {
  return tab.evaluate(() => {
    const root = document.documentElement;
    const style = document.querySelector<HTMLStyleElement>('style[data-ba="dark-mode"]');
    const effectiveBackground = (): string => {
      for (let el: HTMLElement | null = document.querySelector("main"); el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)") return color;
      }
      return "none";
    };
    return {
      htmlDarkClass: root.classList.contains("dark"),
      zzNight: document.body.classList.contains("zz-night"),
      dataBaStyle: style?.textContent ?? undefined,
      rootFilter: getComputedStyle(root).filter,
      rootColorScheme: getComputedStyle(root).colorScheme,
      mainBackground: effectiveBackground(),
    };
  });
}

async function strategyStored(worker: Worker): Promise<string | undefined> {
  const stored = await worker.evaluate((key: string) => chrome.storage.local.get(key), STRATEGY_KEY);
  const map = stored[STRATEGY_KEY] as Record<string, string> | undefined;
  return map?.[HOST];
}

async function openDarkPage(context: BrowserContext, worker: Worker, name: string): Promise<Page> {
  await seedSavedDark(worker);
  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/${name}`);
  await tab.getByText(/Changed this page for you/).waitFor({ timeout: 15_000 });
  const dark = await waitFor(async () => (await renderedLuma(tab)) < 80, 15_000);
  assert(dark, `${name}: the rendered page turned dark`);
  return tab;
}

async function undoAndCheckLight(tab: Page, name: string): Promise<void> {
  const banner = tab.getByRole("button", { name: "Undo" });
  await banner.waitFor({ timeout: 5_000 });
  await banner.click();
  const light = await waitFor(async () => (await renderedLuma(tab)) > 170, 10_000);
  const after = await factsOf(tab);
  assert(light, `${name}: Undo restored the light page`);
  assert(after.dataBaStyle === undefined, `${name}: Undo removed the injected style`);
  assert(!after.htmlDarkClass && !after.zzNight, `${name}: Undo removed the classes it set`);
  assert(after.rootFilter === "none", `${name}: Undo removed the invert filter`);
}

async function checkStrategy(
  context: BrowserContext,
  worker: Worker,
  name: string,
  expected: Strategy,
  verify: (facts: PageFacts) => void,
): Promise<void> {
  const tab = await openDarkPage(context, worker, name);
  const facts = await factsOf(tab);
  verify(facts);
  const stored = await waitFor(async () => (await strategyStored(worker)) === expected, 5_000);
  assert(stored, `${name}: the working strategy "${expected}" was remembered for ${HOST}`);
  await undoAndCheckLight(tab, name);
  await tab.close();
}

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);

  await seedProfile(context, {
    version: 1,
    summary: "Prefers dark colors.",
    needs: [{ id: "n1", kind: "text_size", detail: "prefers dark colors", source: "onboarding" }],
  });
  const worker = await getWorker(context);

  await checkStrategy(context, worker, "dark-class.html", "class", (facts) => {
    assert(facts.htmlDarkClass, "class: the site's own dark class was added to html");
    assert(facts.rootFilter === "none", "class: no invert filter on html");
    assert(facts.rootColorScheme.includes("dark"), "class: color-scheme is dark on html");
    assert(facts.mainBackground === "rgb(17, 17, 17)", `class: the site's dark background shows (${facts.mainBackground})`);
  });

  await checkStrategy(context, worker, "dark-media.html", "media", (facts) => {
    assert(/rgb\(17, 17, 17\)|#111/.test(facts.dataBaStyle ?? ""), "media: the site's dark-scheme rules were injected unwrapped");
    assert(facts.rootFilter === "none", "media: no invert filter on html");
    assert(facts.mainBackground === "rgb(17, 17, 17)", `media: the site's dark background shows (${facts.mainBackground})`);
  });

  await checkStrategy(context, worker, "dark-toggle.html", "toggle", (facts) => {
    assert(facts.zzNight, "toggle: the site's own switch was clicked (body has zz-night)");
    assert(facts.rootFilter === "none", "toggle: no invert filter on html");
    assert(facts.mainBackground === "rgb(17, 17, 17)", `toggle: the site's dark background shows (${facts.mainBackground})`);
  });

  await checkStrategy(context, worker, "dark-none.html", "invert", (facts) => {
    assert(facts.rootFilter.includes("invert"), `invert: html carries the invert filter (${facts.rootFilter})`);
  });

  console.log("DARK PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
