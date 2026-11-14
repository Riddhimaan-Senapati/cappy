import { chromium, type BrowserContext, type Locator, type Page, type Worker } from "playwright";
import { join, resolve } from "node:path";
import type { Profile } from "@browser-agent/shared";

export const root = resolve(import.meta.dir, "..");
export const extensionPath = join(root, "apps/extension/.output/chrome-mv3");
const fixturesDir = join(root, "scripts/fixtures");

// The extension hardcodes DEFAULT_BACKEND_URL to localhost:8787, so every script uses this port.
export const BACKEND_PORT = 8787;

export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

export async function startBackend(opts: {
  port: number;
  env?: Record<string, string>;
  envFile?: string;
}): Promise<Bun.Subprocess> {
  const taken = await fetch(`http://localhost:${opts.port}/health`).then((r) => r.ok, () => false);
  if (taken) {
    throw new Error(
      `port ${opts.port} already serves a backend (likely your \`bun run dev\`); stop it first so this test uses its own backend: lsof -ti tcp:${opts.port} -sTCP:LISTEN | xargs kill`,
    );
  }
  const args = ["bun", ...(opts.envFile ? [`--env-file=${opts.envFile}`] : []), "src/index.ts"];
  const proc = Bun.spawn(args, {
    cwd: join(root, "apps/backend"),
    env: { ...process.env, PORT: String(opts.port), ...opts.env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const health = `http://localhost:${opts.port}/health`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(health).then((r) => r.ok, () => false)) return proc;
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`FAIL: backend did not answer ${health} within 10s`);
}

export function serveFixtures(port: number): Bun.Server {
  return Bun.serve({
    port,
    async fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\/+/, "") || "plain.html";
      if (name.includes("/") || name.includes("..")) return new Response("not found", { status: 404 });
      const file = Bun.file(join(fixturesDir, name));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
}

export function launchWithExtension(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

export async function getWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
}

export function extensionIdFrom(worker: Worker): string {
  return new URL(worker.url()).host;
}

export async function seedProfile(context: BrowserContext, profile: Profile): Promise<void> {
  const worker = await getWorker(context);
  await worker.evaluate((p: unknown) => chrome.storage.local.set({ profile: p }), profile);
}

export function fontSizeOf(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
}

// text_scale scales px-sized text, so root font-size stays put; the paragraph shows the change.
export function paragraphPxOf(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("p")!).fontSize));
}

// The side panel's request box is being redesigned, so accept either its label or its placeholder.
export async function requestBox(panel: Page): Promise<Locator> {
  const byLabel = panel.getByLabel("Ask for a change");
  if (await byLabel.count()) return byLabel.first();
  return panel.getByPlaceholder(/what you need/i).first();
}

// The send button is the one in the same form as the request box, whatever the panel looks like.
export async function requestSendButton(panel: Page): Promise<Locator> {
  const form = (await requestBox(panel)).locator("xpath=ancestor::form[1]");
  const scope = (await form.count()) ? form : panel;
  return scope.getByRole("button", { name: /send|ask|submit/i }).first();
}

type CardStats = {
  podcastsShown: number;
  podcastTotal: number;
  othersHidden: number;
  othersTotal: number;
  lateTotal: number;
  latePodcastTotal: number;
  latePodcastsShown: number;
  lateOthersHidden: number;
};

export function readCardStats(page: Page): Promise<CardStats> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>("ytd-rich-item-renderer")];
    const shown = (el: HTMLElement) => getComputedStyle(el).display !== "none";
    const podcasts = cards.filter((c) => c.hasAttribute("data-podcast"));
    const others = cards.filter((c) => !c.hasAttribute("data-podcast"));
    const late = cards.filter((c) => c.hasAttribute("data-late"));
    return {
      podcastsShown: podcasts.filter(shown).length,
      podcastTotal: podcasts.length,
      othersHidden: others.filter((c) => !shown(c)).length,
      othersTotal: others.length,
      lateTotal: late.length,
      latePodcastTotal: late.filter((c) => c.hasAttribute("data-podcast")).length,
      latePodcastsShown: late.filter((c) => c.hasAttribute("data-podcast") && shown(c)).length,
      lateOthersHidden: late.filter((c) => !c.hasAttribute("data-podcast") && !shown(c)).length,
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

// Shared by e2e-filter and e2e-filter-live: remove podcasts on youtube.html, then Undo, including late loads.
export async function podcastFilterFlow(context: BrowserContext, worker: Worker, pageUrl: string, request: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.waitForFunction(() => document.querySelectorAll("ytd-rich-item-renderer").length >= 28);
  const before = await readCardStats(page);
  assert(before.podcastTotal >= 10 && before.podcastsShown === before.podcastTotal, `precondition: podcast cards are visible before the request (${before.podcastsShown}/${before.podcastTotal})`);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`);
  await (await requestBox(panel)).fill(request);
  await page.bringToFront();
  await (await requestSendButton(panel)).click();

  const hidden = await waitFor(async () => {
    const s = await readCardStats(page);
    return s.podcastsShown === 0 && s.othersHidden === 0;
  }, 20_000);
  const first = await readCardStats(page);
  assert(hidden, `"${request}" hides all podcast cards and keeps the other cards (podcasts shown ${first.podcastsShown}/${first.podcastTotal}, others hidden ${first.othersHidden}/${first.othersTotal})`);

  // The page appends 8 cards, 3 of them podcasts, 1.5s after load; they must be filtered when they arrive.
  const appended = await waitFor(async () => (await readCardStats(page)).lateTotal === 8, 10_000);
  await Bun.sleep(2_000);
  const late = await readCardStats(page);
  assert(appended, `page appended 8 late cards (got ${late.lateTotal})`);
  assert(late.latePodcastsShown === 0 && late.latePodcastTotal === 3, `late-loaded podcast cards are hidden (${late.latePodcastsShown} shown of ${late.latePodcastTotal})`);
  assert(late.lateOthersHidden === 0, `late-loaded non-podcast cards stay visible (${late.lateOthersHidden} hidden)`);

  const undo = async () => {
    for (const scope of [page, panel]) {
      const button = scope.getByRole("button", { name: /undo/i }).first();
      if (await button.count()) return button;
    }
    return undefined;
  };
  const undoReady = await waitFor(async () => (await undo()) !== undefined, 15_000);
  assert(undoReady, "the change banner offers Undo");
  await (await undo())!.click();

  const restored = await waitFor(async () => {
    const s = await readCardStats(page);
    return s.podcastsShown === s.podcastTotal && s.othersHidden === 0 && s.lateOthersHidden === 0 && s.latePodcastsShown === s.latePodcastTotal;
  }, 10_000);
  const after = await readCardStats(page);
  assert(restored, `Undo shows all podcast cards and non-podcast cards again (${after.podcastsShown}/${after.podcastTotal} podcasts shown, ${after.othersHidden} others hidden)`);
  await page.close();
  await panel.close();
}
