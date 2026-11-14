import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import {
  BACKEND_PORT,
  getWorker,
  launchWithExtension,
  podcastFilterFlow,
  root,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5191;
const REQUEST = "remove all podcasts";
const envFile = join(root, ".env");

// Only checks that a key is present; the key itself is never printed.
const hasKey = /^GEMINI_API_KEY=\s*\S+/m.test(await Bun.file(envFile).text().catch(() => ""));
if (!hasKey) {
  console.log(`SKIPPED: no GEMINI_API_KEY in ${envFile}`);
  process.exit(0);
}

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-live-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  backend = await startBackend({ port: BACKEND_PORT, envFile });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);
  await seedProfile(context, { version: 0, summary: "", needs: [] });

  await podcastFilterFlow(context, worker, `http://localhost:${PAGE_PORT}/youtube.html`, REQUEST);
  console.log("FILTER LIVE PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
