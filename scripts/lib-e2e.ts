import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { join, resolve } from "node:path";
import type { Profile } from "@browser-agent/shared";

export const root = resolve(import.meta.dir, "..");
export const extensionPath = join(root, "apps/extension/.output/chrome-mv3");
const fixturesDir = join(root, "scripts/fixtures");

// The extension hardcodes DEFAULT_BACKEND_URL to localhost:8787, so every script uses this port.
export const BACKEND_PORT = 8787;

export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

export async function startBackend(opts: {
  port: number;
  env?: Record<string, string>;
  envFile?: string;
}): Promise<Bun.Subprocess> {
  const args = ["bun", ...(opts.envFile ? [`--env-file=${opts.envFile}`] : []), "src/index.ts"];
  const proc = Bun.spawn(args, {
    cwd: join(root, "apps/backend"),
    env: { ...process.env, PORT: String(opts.port), ...opts.env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const health = `http://localhost:${opts.port}/health`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(health).then((r) => r.ok, () => false)) return proc;
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`FAIL: backend did not answer ${health} within 10s`);
}

export function serveFixtures(port: number): Bun.Server {
  return Bun.serve({
    port,
    async fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\/+/, "") || "plain.html";
      if (name.includes("/") || name.includes("..")) return new Response("not found", { status: 404 });
      const file = Bun.file(join(fixturesDir, name));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
}

export function launchWithExtension(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

export async function getWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
}

export function extensionIdFrom(worker: Worker): string {
  return new URL(worker.url()).host;
}

export async function seedProfile(context: BrowserContext, profile: Profile): Promise<void> {
  const worker = await getWorker(context);
  await worker.evaluate((p: unknown) => chrome.storage.local.set({ profile: p }), profile);
}

export function fontSizeOf(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
}
