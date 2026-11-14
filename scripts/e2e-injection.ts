import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
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

const PAGE_PORT = 5181;

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);

  await seedProfile(context, {
    version: 1,
    summary: "Prefers larger text.",
    needs: [{ id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" }],
  });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/injection.html`);

  let last: { status?: string; reason?: string } | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    last = await worker.evaluate(async () => (await chrome.storage.session.get("last")).last);
    if (last?.status === "blocked") break;
    await Bun.sleep(200);
  }
  assert(last?.status === "blocked", "injected page was blocked by the backend guard");
  assert(
    typeof last.reason === "string" && last.reason.includes("tried to give the agent instructions"),
    "block reason tells the user the page tried to give the agent instructions",
  );

  await Bun.sleep(4_000);
  assert((await fontSizeOf(tab)) === "16px", "blocked page was not adapted: html font-size stays 16px");
  assert((await tab.getByText(/Changed this page for you/).count()) === 0, "no banner appeared within 4s");

  console.log("INJECTION PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
