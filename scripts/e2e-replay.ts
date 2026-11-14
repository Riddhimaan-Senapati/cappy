import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  BACKEND_PORT,
  assert,
  getWorker,
  launchWithExtension,
  paragraphPxOf,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5186;
const HOST = "localhost";

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

async function savedHosts(ctx: BrowserContext): Promise<string[]> {
  const worker = await getWorker(ctx);
  const stored = (await worker.evaluate(() => chrome.storage.local.get("savedChanges"))) as {
    savedChanges?: Record<string, unknown>;
  };
  return Object.keys(stored.savedChanges ?? {});
}

async function waitForSaved(ctx: BrowserContext, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await savedHosts(ctx)).includes(HOST)) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function waitForParagraphPx(tab: Page, predicate: (px: number) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await paragraphPxOf(tab))) return;
    await Bun.sleep(100);
  }
  throw new Error(`FAIL: paragraph font-size did not reach the expected value within ${timeoutMs}ms`);
}

const grew = (px: number) => px >= 16 * 1.25;
const original = (px: number) => px === 16;

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);

  await seedProfile(context, {
    version: 1,
    summary: "Prefers larger text.",
    needs: [{ id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" }],
  });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/plain.html`);
  await waitForParagraphPx(tab, grew, 10_000);
  assert(grew(await paragraphPxOf(tab)), "first visit: backend adaptation scaled the paragraph 16px -> 20.8px");

  await Bun.sleep(2_000);
  assert(await waitForSaved(context, 8_000), "verified change was saved for localhost");

  backend.kill();
  await backend.exited;
  backend = undefined;

  await tab.reload();
  await waitForParagraphPx(tab, grew, 3_000);
  assert(grew(await paragraphPxOf(tab)), "revisit with the backend stopped: replayed the paragraph scale within 3s");

  await tab.getByRole("button", { name: "Undo" }).click();
  await waitForParagraphPx(tab, original, 5_000);
  assert(!(await savedHosts(context)).includes(HOST), "undo forgot the saved change for localhost");

  await tab.reload();
  await Bun.sleep(3_000);
  assert(original(await paragraphPxOf(tab)), "after undo and reload the paragraph stays 16px");

  console.log("REPLAY PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
