import { launchBrowser, startServer, buildExtension, BASE_URL } from "../e2e/lib.js";

// Times how long 12 saved changes take to appear after DOMContentLoaded on any URL. Needs port 8787 free.
// Usage: bun scripts/perf/reapply.ts [--runs 3] [--count 12] <url> [<url>...]
// With no URL it times the demo pages served by the local server.

const args = process.argv.slice(2);
const take = (flag: string, fallback: number) => {
  const at = args.indexOf(flag);
  if (at < 0) return fallback;
  const [, value] = args.splice(at, 2);
  return Number(value) || fallback;
};
const runs = take("--runs", 3);
const count = take("--count", 12);
const urls = args.length ? args : [`${BASE_URL}/demo/campus.html`, `${BASE_URL}/demo/youtube.html`];

const SELECTORS = ["p", "a", "h1, h2, h3", "li", "button", "input", "img", "span", "div", "nav", "section", "footer"];
const changes = Array.from({ length: count }, (_, index) => ({
  id: `perf-${index}`,
  summary: `Perf change ${index}`,
  reason: "timing",
  css: `${SELECTORS[index % SELECTORS.length]} { letter-spacing: ${(index % 3) * 0.01}em !important; }`,
  dom: null,
  block: null,
  scope: "everywhere",
  schedule: null,
  appliedAt: Date.now(),
}));

const label = (url: string) => {
  const { host, pathname } = new URL(url);
  return `${host}${pathname === "/" ? "" : pathname}`.slice(0, 44);
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

buildExtension();
const server = await startServer();
const browser = await launchBrowser("perf");
const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
await worker.evaluate((saved) => chrome.storage.local.set({ paused: false, proactive: false, globalChanges: saved }), changes);

const rows: string[] = [];
try {
  for (const url of urls) {
    const times: number[] = [];
    let elements = 0;
    let failed = "";
    for (let run = 0; run < runs; run++) {
      const page = await browser.context.newPage();
      await page.addInitScript((expected) => {
        const marks = { dcl: 0, done: 0 };
        (window as unknown as { __perf: typeof marks }).__perf = marks;
        const seen = () => document.querySelectorAll('style[data-ba^="change:perf-"]').length;
        const check = () => {
          if (!marks.dcl || marks.done || seen() < expected) return;
          marks.done = performance.now();
        };
        new MutationObserver(check).observe(document, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", () => {
          marks.dcl = performance.now();
          check();
        });
      }, count);
      try {
        await page.goto(url, { waitUntil: "load", timeout: 45_000 });
        await page.waitForFunction(() => (window as unknown as { __perf: { done: number } }).__perf.done > 0, undefined, { timeout: 10_000 });
        const marks = await page.evaluate(() => (window as unknown as { __perf: { dcl: number; done: number } }).__perf);
        times.push(Math.max(0, marks.done - marks.dcl));
        elements = await page.evaluate(() => document.querySelectorAll("*").length);
      } catch (error) {
        failed = error instanceof Error ? error.message.split("\n")[0] : String(error);
      } finally {
        await page.close();
      }
    }
    rows.push(times.length ? `${label(url).padEnd(44)} ${String(elements).padStart(6)} elements  median ${Math.round(median(times))} ms  (runs: ${times.map((t) => Math.round(t)).join(", ")})` : `${label(url).padEnd(44)} FAILED ${failed}`);
  }
} finally {
  await browser.close();
  await server.stop();
}
console.log(`\nTime from DOMContentLoaded to all ${count} saved changes on screen, ${runs} runs per page:`);
for (const row of rows) console.log(row);
