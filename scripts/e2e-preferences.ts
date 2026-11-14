import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "@browser-agent/shared";
import type { BrowserContext, Page, Worker } from "playwright";
import {
  BACKEND_PORT,
  assert,
  getWorker,
  launchWithExtension,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

// The extension reaches the backend on BACKEND_PORT. By default this script answers the compile endpoint
// itself so it runs offline; E2E_REAL_BACKEND=1 uses the real backend instead.
const PAGE_PORT = 5194;
const REAL_BACKEND = process.env.E2E_REAL_BACKEND === "1";
const COMPILE_PATH = "/compile-preference";

type Need = Profile["needs"][number];
const dark: Need = { id: "p-dark", kind: "preference", detail: "prefers dark mode", source: "onboarding" } as Need;
const shorts: Need = { id: "p-shorts", kind: "preference", detail: "no shorts", source: "onboarding" } as Need;

type StoreEntry = { detail: string; status: string; summary?: string };

function stubCompile(detail: string): unknown {
  if (detail.includes("dark")) {
    return {
      kind: "compiled",
      summary: "dark backgrounds with light text",
      change: { css: "html { filter: invert(1) hue-rotate(180deg); }", blocks: [], filters: [] },
    };
  }
  if (detail.includes("shorts")) {
    return {
      kind: "compiled",
      summary: "hides YouTube Shorts cards",
      change: { blocks: [], filters: [{ keywords: ["Shorts"], action: "hide" }] },
    };
  }
  return { kind: "none", reason: "needs a one-off answer, not a page change" };
}

function startStubBackend(): { stop: () => void; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  let server: Bun.Server;
  try {
    server = Bun.serve({
      port: BACKEND_PORT,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/health") return Response.json({ ok: true });
        if (path === COMPILE_PATH && req.method === "POST") {
          const body = (await req.json()) as { need: { detail: string } };
          calls.set(COMPILE_PATH, (calls.get(COMPILE_PATH) ?? 0) + 1);
          return Response.json(stubCompile(body.need.detail));
        }
        calls.set(path, (calls.get(path) ?? 0) + 1);
        return new Response("not found", { status: 404 });
      },
    });
  } catch {
    throw new Error(
      `port ${BACKEND_PORT} is already in use; stop the process on it first: lsof -ti tcp:${BACKEND_PORT} -sTCP:LISTEN | xargs kill`,
    );
  }
  return { stop: () => server.stop(true), calls };
}

async function storeOf(worker: Worker): Promise<Record<string, StoreEntry>> {
  return worker.evaluate(async () => (await chrome.storage.local.get("preferenceChanges")).preferenceChanges ?? {});
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function waitForStatus(worker: Worker, id: string, status: string, timeoutMs: number): Promise<boolean> {
  return waitFor(async () => (await storeOf(worker))[id]?.status === status, timeoutMs);
}

async function setProfilePreferences(context: BrowserContext, version: number, needs: Need[]): Promise<void> {
  await seedProfile(context, { version, summary: "Likes a dark, Shorts-free feed.", needs });
}

// The filter sits on the html element, so the computed value shows whether the preference layer is applied.
function htmlFilter(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).filter);
}

function readShorts(page: Page) {
  return page.evaluate(() => {
    const hiddenHere = (el: Element) => el.closest<HTMLElement>('[style*="display: none"]') !== null;
    const cards = [...document.querySelectorAll<HTMLElement>("ytd-rich-item-renderer")];
    const shorts = cards.filter((c) => c.hasAttribute("data-shorts"));
    const initial = shorts.filter((c) => !c.hasAttribute("data-late-shorts"));
    const late = shorts.filter((c) => c.hasAttribute("data-late-shorts"));
    const others = cards.filter((c) => !c.hasAttribute("data-shorts"));
    return {
      initialTotal: initial.length,
      initialHidden: initial.filter(hiddenHere).length,
      lateTotal: late.length,
      lateHidden: late.filter(hiddenHere).length,
      othersHidden: others.filter(hiddenHere).length,
    };
  });
}

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let stub: ReturnType<typeof startStubBackend> | undefined;
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

try {
  if (REAL_BACKEND) {
    backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  } else {
    stub = startStubBackend();
  }
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);
  const worker = await getWorker(context);

  await setProfilePreferences(context, 1, [dark]);
  if (!(await waitForStatus(worker, dark.id, "compiled", 10_000))) {
    const probe = await fetch(`http://localhost:${BACKEND_PORT}${COMPILE_PATH}`, { method: "POST", body: "{}" }).then(
      (r) => r.status,
      () => "unreachable",
    );
    const entry = (await storeOf(worker))[dark.id];
    throw new Error(
      `FAIL: "prefers dark mode" is compiled within 10s (status ${entry?.status ?? "missing"}; compile endpoint answers ${probe}${probe === 404 ? ", endpoint missing" : ""})`,
    );
  }
  console.log(`ok: "prefers dark mode" is compiled within 10s (${(await storeOf(worker))[dark.id]?.summary})`);

  const plain = await context.newPage();
  await plain.goto(`http://localhost:${PAGE_PORT}/plain.html`);
  const inverted = await waitFor(async () => (await htmlFilter(plain)).includes("invert"), 10_000);
  assert(inverted, `plain.html html filter carries the preference layer (${await htmlFilter(plain)})`);
  const styleInPlace = await plain.evaluate(() => document.querySelector('style[data-ba="preferences"]') !== null);
  assert(styleInPlace, "the preference layer is a data-ba=preferences style on the page");
  if (stub) {
    const adapt = stub.calls.get("/adapt") ?? 0;
    const request = stub.calls.get("/request") ?? 0;
    assert(adapt === 0 && request === 0, `dark mode needed no /adapt or /request call (adapt ${adapt}, request ${request})`);
  }
  await plain.close();

  await setProfilePreferences(context, 2, [dark, shorts]);
  assert(await waitForStatus(worker, shorts.id, "compiled", 10_000), `"no shorts" is compiled within 10s`);

  const video = await context.newPage();
  await video.goto(`http://localhost:${PAGE_PORT}/youtube.html`);
  await video.waitForFunction(() => document.querySelectorAll("ytd-rich-item-renderer").length >= 28);
  const shortsHidden = await waitFor(async () => {
    const s = await readShorts(video);
    return s.lateTotal === 2 && s.initialHidden === s.initialTotal && s.initialTotal > 0 && s.lateHidden === 2;
  }, 15_000);
  const s = await readShorts(video);
  assert(
    shortsHidden,
    `Shorts cards are hidden, including late ones (initial ${s.initialHidden}/${s.initialTotal}, late ${s.lateHidden}/${s.lateTotal})`,
  );
  assert(s.othersHidden === 0, `non-Shorts cards stay visible (${s.othersHidden} hidden)`);
  assert((await htmlFilter(video)).includes("invert"), "dark mode still applies on the same page as the Shorts filter");

  await setProfilePreferences(context, 3, [shorts]);
  const darkGone = await waitFor(async () => (await storeOf(worker))[dark.id] === undefined, 10_000);
  assert(darkGone, "removing the dark mode preference deletes its stored change");
  await video.close();

  const plainAgain = await context.newPage();
  await plainAgain.goto(`http://localhost:${PAGE_PORT}/plain.html`);
  await Bun.sleep(500);
  const filter = await htmlFilter(plainAgain);
  assert(!filter.includes("invert") && filter === "none", `after removal, plain.html has no preference filter (${filter})`);
  await plainAgain.close();

  const kill = await context.newPage();
  await kill.goto(`http://localhost:${PAGE_PORT}/youtube.html`);
  await kill.waitForFunction(() => document.querySelectorAll("ytd-rich-item-renderer").length >= 28);
  assert(await waitFor(async () => (await readShorts(kill)).lateHidden === 2, 15_000), "Shorts are hidden again before the kill switch");

  await worker.evaluate(() => chrome.storage.local.set({ paused: true }));
  const clearedWhenPaused = await waitFor(async () => (await readShorts(kill)).initialHidden === 0, 10_000);
  assert(clearedWhenPaused, "the kill switch clears the preference layer on the open tab (Shorts visible)");

  await worker.evaluate(() => chrome.storage.local.set({ paused: false }));
  const restored = await waitFor(async () => (await readShorts(kill)).initialHidden === (await readShorts(kill)).initialTotal, 10_000);
  assert(restored, "turning the kill switch off restores the Shorts filter on the open tab");

  await kill.close();
  console.log("PREFERENCES PASSED");
} finally {
  await context?.close();
  stub?.stop();
  backend?.kill();
  page?.stop(true);
  rmSync(userDataDir, { recursive: true, force: true });
}
