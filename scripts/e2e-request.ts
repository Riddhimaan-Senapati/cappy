import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  BACKEND_PORT,
  assert,
  extensionIdFrom,
  fontSizeOf,
  getWorker,
  launchWithExtension,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5183;
const REQUEST = "make the text bigger";

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);

  // An empty profile keeps the page-load adaptation from changing font-size, so only the request can.
  await seedProfile(context, { version: 0, summary: "", needs: [] });

  const plain = await context.newPage();
  await plain.goto(`http://localhost:${PAGE_PORT}/plain.html`);
  const before = await fontSizeOf(plain);
  assert(before === "16px", `precondition: plain.html starts at 16px (got ${before})`);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`);
  await panel.getByLabel("Message the agent").fill(REQUEST);

  // The request targets the active tab, so the plain page must be frontmost before Send is clicked.
  await plain.bringToFront();
  await panel.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>("form.composer button[type=submit]");
    if (!send) throw new Error("FAIL: Send button not found in side panel");
    send.click();
  });

  const deadline = Date.now() + 15_000;
  let after = before;
  while (Date.now() < deadline) {
    after = await fontSizeOf(plain);
    if (after !== before) break;
    await Bun.sleep(200);
  }
  assert(parseFloat(after) > parseFloat(before), `"${REQUEST}" grew the active tab's font-size (${before} -> ${after})`);

  console.log("REQUEST PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
