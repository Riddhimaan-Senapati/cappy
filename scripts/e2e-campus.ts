import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  BACKEND_PORT,
  assert,
  launchWithExtension,
  seedProfile,
  serveFixtures,
  startBackend,
} from "./lib-e2e";

const PAGE_PORT = 5189;
const WINDOW_MS = 15_000;

const userDataDir = mkdtempSync(join(tmpdir(), "ba-e2e-"));
let backend: Bun.Subprocess | undefined;
let page: Bun.Server | undefined;
let context: BrowserContext | undefined;

type Snapshot = {
  paragraphPx: number;
  tickerAnimations: number;
  tickerRunning: number;
  unlabelled: number;
};

async function snapshot(tab: Page): Promise<Snapshot> {
  return tab.evaluate(() => {
    const paragraph = document.querySelector("article p");
    const ticker = document.querySelector(".ticker") as HTMLElement | null;
    const animations = ticker?.getAnimations() ?? [];
    const controls = Array.from(document.querySelectorAll("form input, form select, form textarea"));
    const unlabelled = controls.filter(
      (el) => !el.id || !document.querySelector(`label[for="${CSS.escape(el.id)}"]`),
    ).length;
    return {
      paragraphPx: paragraph ? parseFloat(getComputedStyle(paragraph).fontSize) : 0,
      tickerAnimations: animations.length,
      tickerRunning: animations.filter((a) => a.playState === "running").length,
      unlabelled: controls.length === 0 ? Number.POSITIVE_INFINITY : unlabelled,
    };
  });
}

try {
  backend = await startBackend({ port: BACKEND_PORT, env: { GEMINI_API_KEY: "" } });
  page = serveFixtures(PAGE_PORT);
  context = await launchWithExtension(userDataDir);

  await seedProfile(context, {
    version: 1,
    summary: "Maya is red-green colorblind, sensitive to flashing light, prefers larger text, and has limited wrist mobility.",
    needs: [
      { id: "n1", kind: "color_vision", detail: "red-green colorblind (deuteranopia)", source: "onboarding" },
      { id: "n2", kind: "light_sensitivity", detail: "flashing content gives headaches", source: "onboarding" },
      { id: "n3", kind: "text_size", detail: "prefers larger text", source: "onboarding" },
      { id: "n4", kind: "motor", detail: "wrist in a cast, hard to hit small targets", source: "onboarding" },
    ],
  });

  const tab = await context.newPage();
  await tab.goto(`http://localhost:${PAGE_PORT}/campus.html`);

  // Each block applies on its own schedule, so poll all of them against one shared window.
  const deadline = Date.now() + WINDOW_MS;
  let state = await snapshot(tab);
  const done = (s: Snapshot) =>
    s.paragraphPx >= 15 && s.tickerAnimations > 0 && s.tickerRunning === 0 && s.unlabelled === 0;
  while (!done(state) && Date.now() < deadline) {
    await Bun.sleep(250);
    state = await snapshot(tab);
  }

  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (ok) console.log(`ok: ${message}`);
    else {
      console.log(`FAIL: ${message}`);
      failures.push(message);
    }
  };

  check(
    state.paragraphPx >= 15,
    `text_scale: article paragraph font-size grew by >= 25% from 12px (now ${state.paragraphPx}px)`,
  );
  check(
    state.tickerAnimations > 0 && state.tickerRunning === 0,
    `stop_motion: ticker animations are paused (${state.tickerRunning} of ${state.tickerAnimations} running)`,
  );
  check(
    state.unlabelled === 0,
    `form_fixer: every form input has a label[for] (${state.unlabelled} without one)`,
  );

  const banner = tab.getByText(/Changed this page for you/).first();
  const bannerVisible = await banner.isVisible({ timeout: 5_000 }).catch(() => false);
  check(bannerVisible, "banner: the 'Changed this page for you' banner is visible");

  if (bannerVisible) {
    await tab.getByRole("button", { name: "Undo" }).click();
    const restored = await tab
      .waitForFunction(() => {
        const p = document.querySelector("article p");
        return !!p && parseFloat(getComputedStyle(p).fontSize) === 12;
      }, null, { timeout: 5_000 })
      .then(() => true, () => false);
    check(restored, "undo: article paragraph font-size returns to 12px");
  } else {
    console.log("skip: undo (no banner to click Undo on)");
  }

  if (failures.length > 0) {
    throw new Error(`CAMPUS FAILED: ${failures.length} assertion(s) did not hold:\n- ${failures.join("\n- ")}`);
  }
  console.log("CAMPUS PASSED");
} finally {
  await context?.close();
  page?.stop(true);
  backend?.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
