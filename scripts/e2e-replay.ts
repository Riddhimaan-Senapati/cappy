import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  BACKEND_PORT,
  assert,
  fontSizeOf,
  getWorker,
  launchWithExtension,
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

async function waitForFontSize(tab: Page, size: string, timeoutMs: number): Promise<void> {
  await tab.waitForFunction(
    (expected) => getComputedStyle(document.documentElement).fontSize === expected,
    size,
    { timeout: timeoutMs },
  );
}

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
  await tab.waitForFunction(() => getComputedStyle(document.documentElement).fontSize !== "16px", null, { timeout: 10_000 });
  assert((await fontSizeOf(tab)) === "20px", "first visit: backend adaptation applied html font-size 16px -> 20px");

  await Bun.sleep(2_000);
  assert(await waitForSaved(context, 8_000), "verified change was saved for localhost");

  backend.kill();
  await backend.exited;
  backend = undefined;

  await tab.reload();
  await waitForFontSize(tab, "20px", 3_000);
  assert((await fontSizeOf(tab)) === "20px", "revisit with the backend stopped: replayed 20px within 3s");

  await tab.getByRole("button", { name: "Undo" }).click();
  await waitForFontSize(tab, "16px", 5_000);
  assert(!(await savedHosts(context)).includes(HOST), "undo forgot the saved change for localhost");

  await tab.reload();
  await Bun.sleep(3_000);
  assert((await fontSizeOf(tab)) === "16px", "after undo and reload the font-size stays 16px");

  console.log("REPLAY PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
