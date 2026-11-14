import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { BACKEND_PORT, assert, fontSizeOf, launchWithExtension, seedProfile, serveFixtures, startBackend } from "./lib-e2e";

const PAGE_PORT = 5185;
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
    summary: "Prefers larger text.",
    needs: [{ id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" }],
  });
  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/plain.html`);
  await tab.waitForFunction(() => getComputedStyle(document.documentElement).fontSize !== "16px", null, { timeout: 10_000 });
  await Bun.sleep(8_000);
  assert((await fontSizeOf(tab)) === "20px", "a helpful adaptation is still applied 8s later, after verification finished");
  console.log("PERSIST PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
