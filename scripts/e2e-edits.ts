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
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5187;
const INVERT = "invert this page";
const HIDE = "hide the sidebar";

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

async function ask(panel: Page, tab: Page, request: string): Promise<void> {
  await panel.getByLabel("Ask for a change").fill(request);
  // The request targets the active tab, so the feed page must be frontmost before Send is clicked.
  await tab.bringToFront();
  await panel.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>("section.request button[type=submit]");
    if (!send) throw new Error("FAIL: Send button not found in side panel");
    send.click();
  });
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`FAIL: timed out waiting for ${what}`);
}

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);

  // An empty profile keeps page-load adaptations quiet, so only the typed requests change the page.
  await seedProfile(context, { version: 0, summary: "", needs: [] });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`);

  const feed = await context.newPage();
  await feed.goto(`http://localhost:${PAGE_PORT}/feed.html`);

  const htmlFilter = () => feed.evaluate(() => getComputedStyle(document.documentElement).filter);
  await ask(panel, feed, INVERT);
  await waitFor(async () => (await htmlFilter()).includes("invert"), "html filter to include invert");
  assert((await htmlFilter()).includes("invert"), `"${INVERT}" set html computed filter to invert (${await htmlFilter()})`);

  await feed.reload();

  const asideDisplay = () => feed.evaluate(() => getComputedStyle(document.getElementById("sidebar")!).display);
  // The style attribute is the one thing hiding is allowed to touch; ids and data attributes must not appear.
  const markup = () =>
    feed.evaluate(() => {
      const aside = document.getElementById("sidebar")!;
      return {
        asideNames: Array.from(aside.attributes, (a) => a.name).filter((n) => n !== "style").sort(),
        ids: Array.from(document.querySelectorAll("[id]"), (e) => e.id),
        dataAttributes: Array.from(document.querySelectorAll("*")).reduce(
          (n, e) => n + Array.from(e.attributes).filter((a) => a.name.startsWith("data-")).length,
          0,
        ),
      };
    });
  const before = await markup();
  assert((await asideDisplay()) !== "none", "precondition: sidebar is visible after reload");

  await ask(panel, feed, HIDE);
  await waitFor(async () => (await asideDisplay()) === "none", "sidebar display none");
  assert((await asideDisplay()) === "none", `"${HIDE}" hid the sidebar`);

  const after = await markup();
  assert(
    JSON.stringify(after.asideNames) === JSON.stringify(before.asideNames) &&
      JSON.stringify(after.ids) === JSON.stringify(before.ids) &&
      after.dataAttributes === before.dataAttributes,
    "hiding added no id or data attributes to the real DOM",
  );

  await feed.getByRole("button", { name: "Undo" }).click();
  await waitFor(async () => (await asideDisplay()) !== "none", "sidebar restored by undo");
  assert((await asideDisplay()) !== "none", "undo restored the sidebar");

  console.log("EDITS PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
