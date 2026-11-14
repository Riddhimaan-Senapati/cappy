import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  BACKEND_PORT,
  assert,
  extensionIdFrom,
  getWorker,
  launchWithExtension,
  startBackend,
} from "./lib-e2e";

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });

  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);
  const panelUrl = `chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`;

  const panel = await context.newPage();
  await panel.goto(panelUrl);
  await panel.getByLabel("Ask for a change").fill("I'm red-green colorblind");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await panel.getByRole("button", { name: "Accept" }).waitFor({ timeout: 15_000 });
  console.log("ok: companion proposed a change before restart");

  await context.close();
  context = undefined;

  context = await launchWithExtension(userDataDir);
  const worker2 = await getWorker(context);
  const panel2 = await context.newPage();
  await panel2.goto(`chrome-extension://${extensionIdFrom(worker2)}/sidepanel.html`);
  await panel2.getByRole("button", { name: "Accept" }).waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error("FAIL: proposal did not survive a browser restart (no Accept button)");
  });
  console.log("ok: proposal survived a full browser restart with the same profile dir");

  await panel2.getByRole("button", { name: "Accept" }).click();

  let hasColorNeed = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !hasColorNeed) {
    const profile = await worker2.evaluate(async () => (await chrome.storage.local.get("profile")).profile);
    hasColorNeed = Boolean(profile?.needs?.some((n: { kind: string }) => n.kind === "color_vision"));
    if (!hasColorNeed) await Bun.sleep(200);
  }
  assert(hasColorNeed, "accepted proposal saved a color_vision need to chrome.storage.local profile");

  console.log("COMPANION RESTART PASSED");
} finally {
  await context?.close();
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
