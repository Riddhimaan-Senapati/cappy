import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { BACKEND_PORT, assert, extensionIdFrom, getWorker, launchWithExtension, startBackend } from "./lib-e2e";

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let context: BrowserContext | undefined;

const colorNeeds = (worker: Awaited<ReturnType<typeof getWorker>>) =>
  worker.evaluate(async () => {
    const { profile } = await chrome.storage.local.get("profile");
    return ((profile?.needs ?? []) as { kind: string }[]).filter((n) => n.kind === "color_vision").length;
  });

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionIdFrom(worker)}/sidepanel.html`);

  await panel.getByLabel("Ask for a change").fill("I'm red-green colorblind");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await panel.getByText(/Remembered:/).waitFor({ timeout: 15_000 });
  assert((await colorNeeds(worker)) === 1, "with Ask before remembering off, the need is saved with no Accept step");
  assert((await panel.getByRole("button", { name: "Accept" }).count()) === 0, "no Accept/Reject card is shown");

  await panel.getByLabel("Ask before remembering").check();
  await panel.getByLabel("Ask for a change").fill("I'm also color blind in dim light");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await panel.getByRole("button", { name: "Accept" }).waitFor({ timeout: 15_000 });
  assert((await colorNeeds(worker)) === 1, "with Ask before remembering on, nothing is saved until Accept");
  await panel.getByRole("button", { name: "Accept" }).click();
  await panel.waitForFunction(() => true);
  for (let i = 0; i < 20 && (await colorNeeds(worker)) < 2; i++) await Bun.sleep(200);
  assert((await colorNeeds(worker)) === 2, "Accept saves the proposed need");

  console.log("REMEMBER PASSED");
} finally {
  await context?.close();
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
