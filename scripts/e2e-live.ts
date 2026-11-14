import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  BACKEND_PORT,
  assert,
  getWorker,
  launchWithExtension,
  root,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5184;
const envFile = join(root, ".env");

const hasKey = existsSync(envFile) && /^GEMINI_API_KEY=\s*\S+/m.test(readFileSync(envFile, "utf8"));
if (!hasKey) {
  console.log("SKIPPED: no GEMINI_API_KEY");
  process.exit(0);
}

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, envFile });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);

  await seedProfile(context, {
    version: 1,
    summary: "Prefers larger text.",
    needs: [{ id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" }],
  });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/plain.html`);

  let last: { status?: string; url?: string; blocks?: string[]; message?: string; reason?: string } | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    last = await worker.evaluate(async () => (await chrome.storage.session.get("last")).last);
    if (last?.status === "applied" || last?.status === "error") break;
    await Bun.sleep(300);
  }
  assert(
    last?.status === "applied",
    `live backend applied an adaptation on plain.html within 30s (last status: ${last?.status ?? "none"}${last?.message ? `, ${last.message}` : ""})`,
  );
  console.log(`info: blocks applied: ${last?.blocks?.join(", ") || "page styles"}`);

  console.log("LIVE PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
