import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const extensionPath = join(root, "apps/extension/.output/chrome-mv3");
const PAGE_PORT = 5180;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

const backend = Bun.spawn(["bun", "src/index.ts"], {
  cwd: join(root, "apps/backend"),
  env: { ...process.env, PORT: "8787", GEMINI_API_KEY: "" },
  stdout: "ignore",
  stderr: "inherit",
});

const page = Bun.serve({
  port: PAGE_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><html><head><title>Survey</title></head><body><h1>Survey</h1><p>Hello</p><aside>Ads</aside><form><input name="q"></form></body></html>`,
      { headers: { "content-type": "text/html" } },
    ),
});

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  for (let i = 0; i < 50; i++) {
    const r = await fetch("http://localhost:8787/health").catch(() => null);
    if (r?.ok) break;
    await Bun.sleep(100);
  }

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() =>
    chrome.storage.local.set({
      profile: {
        version: 1,
        summary: "Prefers larger text and fewer distractions.",
        needs: [
          { id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" },
          { id: "n2", kind: "focus", detail: "distracted by side content", source: "onboarding" },
        ],
      },
    }),
  );

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/`);
  const fontSize = () => tab.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const asideDisplay = () => tab.evaluate(() => getComputedStyle(document.querySelector("aside")!).display);

  await tab.waitForFunction(() => getComputedStyle(document.documentElement).fontSize !== "16px", null, { timeout: 10_000 });
  assert((await fontSize()) === "20px", "backend adaptation installed CSS: html font-size 16px -> 20px");
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
  await context.close();
  page.stop(true);
  backend.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
