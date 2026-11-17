import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright";
import { BASE_URL, EXTENSION_DIR, buildExtension, startServer } from "../e2e/lib.js";

// Runs axe-core over every extension surface in light and dark. The bar and toasts live in closed shadow roots,
// so this loads a throwaway copy of the extension whose content script opens them. Production code is untouched.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const json = process.argv.includes("--json");

buildExtension();
const work = mkdtempSync(path.join(os.tmpdir(), "cappy-a11y-"));
const copy = path.join(work, "extension");
cpSync(EXTENSION_DIR, copy, { recursive: true, filter: (src) => !src.includes("node_modules") });
const content = path.join(copy, "dist", "content.js");
const source = readFileSync(content, "utf8");
const opened = source.replace(/mode:\s*"closed"/g, 'mode:"open"');
if (opened === source) throw new Error("No closed shadow root found in dist/content.js");
writeFileSync(content, opened);

const server = await startServer();
const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`, "--no-first-run"],
});
let worker = context.serviceWorkers()[0];
worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });
const extensionId = new URL(worker.url()).host;
await worker.evaluate(() => chrome.storage.local.set({ onboarded: true }));
for (const page of context.pages()) if (page.url().includes("welcome.html")) await page.close();

interface Hit { surface: string; theme: string; rule: string; impact: string; help: string; nodes: string[] }
const hits: Hit[] = [];

async function scan(page: Page, surface: string, theme: string, scope = false) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (scope) builder = builder.include("[data-ba='ui']");
  const { violations } = await builder.analyze();
  for (const v of violations) {
    hits.push({ surface, theme, rule: v.id, impact: v.impact ?? "", help: v.help, nodes: v.nodes.map((n) => `${n.target.join(" >> ")} :: ${(n.any[0]?.message ?? n.all[0]?.message ?? n.none[0]?.message ?? "").slice(0, 140)}`) });
  }
}

async function setTheme(theme: "dark" | "light") {
  await worker.evaluate((value) => chrome.storage.local.set({ uiTheme: value }), theme);
}

for (const theme of ["dark", "light"] as const) {
  await setTheme(theme);
  for (const file of ["welcome.html", "sidepanel.html"]) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    await page.waitForTimeout(600);
    await scan(page, file, theme);
    await page.close();
  }
  const demo = await context.newPage();
  await demo.goto(`${BASE_URL}/demo/campus.html`);
  await demo.waitForTimeout(800);
  await scan(demo, "floating button", theme, true);
  await demo.evaluate(() => {
    const host = document.querySelector("[data-ba='ui']") as HTMLElement;
    (host.shadowRoot!.querySelector(".fab") as HTMLButtonElement).click();
  });
  await demo.waitForTimeout(700);
  await scan(demo, "bar list", theme, true);
  await demo.evaluate(() => {
    const host = document.querySelector("[data-ba='ui']") as HTMLElement;
    (host.shadowRoot!.querySelector("button[aria-label='Settings']") as HTMLButtonElement).click();
  });
  await demo.waitForTimeout(700);
  await scan(demo, "bar settings", theme, true);
  const tabs = await demo.evaluate(() => [...(document.querySelector("[data-ba='ui']") as HTMLElement).shadowRoot!.querySelectorAll(".s-tabs button")].length);
  for (let i = 1; i < tabs; i++) {
    await demo.evaluate((index) => ((document.querySelector("[data-ba='ui']") as HTMLElement).shadowRoot!.querySelectorAll(".s-tabs button")[index] as HTMLButtonElement).click(), i);
    await demo.waitForTimeout(400);
    await scan(demo, `bar settings tab ${i + 1}`, theme, true);
  }
  await demo.close();
}

await context.close().catch(() => undefined);
await server.stop();
rmSync(work, { recursive: true, force: true });

const grouped = new Map<string, Hit[]>();
for (const hit of hits) grouped.set(hit.rule, [...(grouped.get(hit.rule) ?? []), hit]);
if (json) console.log(JSON.stringify(hits, null, 2));
else {
  for (const [rule, list] of grouped) {
    console.log(`\n${rule} (${list[0]!.impact}) ${list[0]!.help}`);
    const seen = new Set<string>();
    for (const hit of list) for (const node of hit.nodes) {
      const key = `${hit.theme}|${node.replace(/ \(foreground.*/, "")}|${hit.surface.replace(/ tab \d+/, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  [${hit.surface}/${hit.theme}] ${node}`);
    }
  }
  console.log(`\n${hits.length ? `${grouped.size} rules failed` : "no violations"}`);
}
process.exit(hits.length ? 1 : 0);
