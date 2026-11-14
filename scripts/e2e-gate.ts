import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  BACKEND_PORT,
  assert,
  fontSizeOf,
  launchWithExtension,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5180;

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);

  await seedProfile(context, {
    version: 1,
    summary: "Prefers larger text and fewer distractions.",
    needs: [
      { id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" },
      { id: "n2", kind: "focus", detail: "distracted by side content", source: "onboarding" },
    ],
  });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/plain.html`);
  const asideDisplay = () => tab.evaluate(() => getComputedStyle(document.querySelector("aside")!).display);

  await tab.waitForFunction(() => getComputedStyle(document.documentElement).fontSize !== "16px", null, { timeout: 10_000 });
  assert((await fontSizeOf(tab)) === "20px", "backend adaptation installed CSS: html font-size 16px -> 20px");
  assert((await asideDisplay()) === "none", "focus block hid the aside");

  const banner = tab.getByText(/Changed this page for you/);
  await banner.waitFor({ timeout: 5_000 });
  assert(await banner.isVisible(), "banner shows the reason");

  await tab.getByRole("button", { name: "Undo" }).click();
  await tab.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === "16px", null, { timeout: 5_000 });
  assert((await asideDisplay()) !== "none", "undo removed the CSS");
  assert((await tab.getByText(/Changed this page for you/).count()) === 0, "undo removed the banner");

  console.log("GATE PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
