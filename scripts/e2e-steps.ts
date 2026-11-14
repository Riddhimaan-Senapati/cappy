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

const PAGE_PORT = 5188;

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

async function waitForStep(panel: Page, text: string, timeout: number): Promise<string> {
  const step = panel.locator(".timeline-step", { hasText: text }).first();
  await step.waitFor({ timeout });
  return (await step.textContent()) ?? "";
}

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

  // The side panel opens first so the plain page stays the active tab for screenshots.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`);

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/plain.html`);

  const applied = await waitForStep(panel, "Applied", 10_000);
  assert(applied.includes("Applied"), "timeline shows an Applied step for the plain page");
  const verified = await waitForStep(panel, "Verif", 10_000);
  assert(verified.includes("Verif"), "timeline shows a verification step");

  const label = await panel.locator(".timeline-step", { hasText: "Applied" }).first().locator(".timeline-label").textContent();
  assert(label?.trim() === "Done:", "tone is conveyed by a text label, not only by color");

  const injected = await context.newPage();
  await injected.goto(`http://localhost:${PAGE_PORT}/injection.html`);
  const blocked = await waitForStep(panel, "Blocked", 15_000);
  assert(blocked.includes("Blocked"), "timeline shows a Blocked step for the injected page");

  console.log("STEPS PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
