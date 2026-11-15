import assert from "node:assert/strict";
import type { ApplyOutcome } from "../../shared/protocol.js";
import type { Change } from "../../shared/adaptation.js";
import type { ContentRequest, ContentResponse } from "../../extension/src/messages.js";
import { fontSizeOf, openDemo, runE2E, waitFor } from "./lib.js";

const counts = (output: string) => ({
  runs: (output.match(/\[run\] (?:chat|page_load) via /g) ?? []).length,
  pageLoads: (output.match(/\[run\] page_load via /g) ?? []).length,
  chats: (output.match(/\[run\] chat via /g) ?? []).length,
  classify: (output.match(/\[classify\]/g) ?? []).length,
});

await runE2E("request-counts", async ({ browser, server }) => {
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent("serviceworker"));
  const problems: string[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`OK ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${name}: ${message}`);
      problems.push(`${name}: ${message}`);
    }
  };

  async function tabId(url: string) {
    const id = await worker.evaluate(async (target) => (await chrome.tabs.query({})).find((tab) => tab.url === target)?.id, url);
    if (id === undefined) throw new Error(`No tab for ${url}`);
    return id;
  }

  async function pin(page: Awaited<ReturnType<typeof openDemo>>) {
    const mark = Math.random().toString(36).slice(2);
    await page.evaluate((hash) => history.replaceState({}, "", `${location.pathname}${location.search}#${hash}`), mark);
    return tabId(page.url());
  }

  async function apply(id: number, change: Change, requested = false): Promise<ApplyOutcome> {
    return worker.evaluate(async ({ id, change, requested }) => {
      const response: ContentResponse = await chrome.tabs.sendMessage(id, {
        kind: "tool", name: "apply_change", input: { change }, ...(requested ? { requested: true } : {}),
      } satisfies ContentRequest);
      if (!response.ok) throw new Error(response.error);
      return response.result as ApplyOutcome;
    }, { id, change, requested });
  }

  await worker.evaluate(() => chrome.storage.local.set({
    proactive: true, askBeforeAdapting: false, paused: false, profile: ["Enjoys reading about science"],
    commands: [], globalChanges: [], siteChanges: {},
  }));

  await check("two tabs of a new site make one page-load call", async () => {
    const before = counts(server.output()).pageLoads;
    await Promise.all([openDemo(browser, "/demo/youtube.html"), openDemo(browser, "/demo/youtube.html")]);
    await waitFor("the first page-load run", async () => counts(server.output()).pageLoads >= before + 1);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(counts(server.output()).pageLoads, before + 1, `page-load calls: ${counts(server.output()).pageLoads - before}`);
  });

  await worker.evaluate(() => chrome.storage.local.set({ proactive: false, profile: [] }));

  await check("saved page change replays on reload, new tab, and back without a model call", async () => {
    const page = await openDemo(browser, "/demo/campus.html");
    const beforeFont = await fontSizeOf(page);
    const before = counts(server.output()).runs;
    const id = await pin(page);
    const outcome = await apply(id, {
      id: "page-font", summary: "Bigger paragraph", reason: "test", scope: "page",
      css: "article p { font-size: 22px !important; }", dom: null, block: null,
    });
    assert.equal(outcome.ok, true);
    assert.equal(await fontSizeOf(page), 22);
    await page.reload();
    await waitFor("replay after reload", async () => (await fontSizeOf(page)) === 22);
    const second = await openDemo(browser, "/demo/campus.html");
    await waitFor("replay in a new tab", async () => (await fontSizeOf(second)) === 22);
    const form = await openDemo(browser, "/demo/form.html");
    await form.waitForTimeout(400);
    assert.notEqual(await fontSizeOf(form, "h1"), 22);
    await form.goBack().catch(() => undefined);
    await page.bringToFront();
    await page.reload();
    await waitFor("still 22 after another reload", async () => (await fontSizeOf(page)) === 22);
    assert.equal(counts(server.output()).runs, before, "replay called the model");

    await page.evaluate(() => history.pushState({}, "", "/demo/other-path"));
    await page.waitForTimeout(400);
    const moved = await fontSizeOf(page);
    assert.equal(moved, beforeFont, `page-scoped font stayed ${moved}px after an in-page route change`);
    await page.evaluate(() => history.back());
    await waitFor("page rule returns on back", async () => (await fontSizeOf(page)) === 22);
    assert.equal(counts(server.output()).runs, before, "route change called the model");
  });

  await check("alphabetical reorder keeps sorting tiles that load later", async () => {
    const page = await openDemo(browser, "/demo/videos.html");
    const id = await pin(page);
    const before = counts(server.output()).runs;
    const outcome = await apply(id, {
      id: "sort-titles", summary: "Sort titles", reason: "test", scope: "page",
      css: null,
      dom: [{ op: "reorder", selector: "article.tile", keySelector: "h3", direction: "asc", ranking: null }],
      block: null,
    });
    assert.equal(outcome.ok, true, outcome.error ?? "");
    const titles = () => page.locator("article.tile h3").allTextContents();
    await waitFor("titles sorted", async () => {
      const list = await titles();
      return list[0]?.startsWith("Big-O") ? list : undefined;
    });
    await page.evaluate(() => {
      const feed = document.querySelector("#feed")!;
      const card = document.createElement("article");
      card.className = "tile";
      card.innerHTML = `<div class="info"><h3 class="title">Algebra office hours</h3></div>`;
      feed.append(card);
    });
    await waitFor("a new tile sorted into place", async () => (await titles())[0]?.startsWith("Algebra"));
    const ranked = await apply(id, {
      id: "cooking-first", summary: "Cooking first", reason: "test", scope: "page",
      css: null,
      dom: [{
        op: "reorder", selector: "article.tile", keySelector: "h3", direction: "asc",
        ranking: [{ key: "How to cook pasta from scratch", rank: 1 }, { key: "Hackathon pitch tips", rank: 2 }],
        keywords: ["algebra", "pasta", "cooking"],
      }],
      block: null,
    });
    assert.equal(ranked.ok, true, ranked.error ?? "");
    await page.evaluate(() => {
      const feed = document.querySelector("#feed")!;
      const card = document.createElement("article");
      card.className = "tile";
      card.innerHTML = `<div class="info"><h3 class="title">Weeknight pasta bake</h3></div>`;
      feed.append(card);
    });
    await waitFor("a late pasta video joins the front group", async () => {
      const list = await titles();
      const pasta = list.findIndex((title) => title.toLowerCase().includes("pasta"));
      const later = list.findIndex((title) => title.startsWith("Hackathon"));
      return pasta >= 0 && later >= 0 && pasta < later ? list : undefined;
    });
    assert.equal(counts(server.output()).runs, before);
  });

  await check("a keyword filter hides items that load later without a model call", async () => {
    const page = await openDemo(browser, "/demo/videos.html");
    const id = await pin(page);
    const before = counts(server.output());
    const outcome = await apply(id, {
      id: "hide-algebra", summary: "Hide algebra", reason: "test", scope: "page",
      css: null, dom: null,
      block: { name: "contentFilter", keywords: ["algebra"], itemSelector: "article.tile", action: "hide" },
    });
    assert.equal(outcome.ok, true, outcome.error ?? "");
    await waitFor("the algebra tile to hide", () => page.locator("article.tile", { hasText: "Linear algebra" }).isHidden());
    await page.evaluate(() => {
      const feed = document.querySelector("#feed")!;
      for (const title of ["Algebra office hours", "More algebra drills", "Dorm pasta night"]) {
        const card = document.createElement("article");
        card.className = "tile";
        card.innerHTML = `<div class="thumb"></div><div class="info"><h3 class="title">${title}</h3><div class="meta">1 view</div></div>`;
        feed.append(card);
      }
    });
    await waitFor("new algebra tiles to hide", () => page.locator("article.tile", { hasText: "More algebra drills" }).isHidden());
    assert.equal(await page.locator("article.tile", { hasText: "Dorm pasta night" }).isVisible(), true);
    const after = counts(server.output());
    assert.equal(after.classify, before.classify, "keyword filter called the classifier");
    assert.equal(after.runs, before.runs, "keyword filter started a model run");
  });

  await check("a short time rule ends on its own without a model call", async () => {
    const page = await openDemo(browser, "/demo/dark-media.html");
    const id = await pin(page);
    const before = counts(server.output()).runs;
    const untilAt = new Date(Date.now() + 1200).toISOString();
    const outcome = await apply(id, {
      id: "brief-color", summary: "Brief color", reason: "test", scope: "page",
      css: "h1 { color: rgb(1, 2, 3) !important; }", dom: null, block: null,
      schedule: { untilAt },
    });
    assert.equal(outcome.ok, true, outcome.error ?? "");
    await waitFor("the timed color", () => page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color === "rgb(1, 2, 3)"));
    await waitFor("the timed color to end", () => page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color !== "rgb(1, 2, 3)"), 8_000);
    assert.equal(counts(server.output()).runs, before);
  });

  await check("focus mode turns on a rule that is outside its window", async () => {
    const page = await openDemo(browser, "/demo/form.html");
    const id = await pin(page);
    const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const other = names[(new Date().getDay() + 1) % 7];
    const before = counts(server.output()).runs;
    const outcome = await apply(id, {
      id: "focus-color", summary: "Focus color", reason: "test", scope: "page",
      css: "h1 { color: rgb(4, 5, 6) !important; }", dom: null, block: null,
      schedule: { days: [other], start: "00:00", end: "23:59" },
    });
    assert.equal(outcome.ok, true, outcome.error ?? "");
    await page.waitForTimeout(300);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color), "rgb(4, 5, 6)");
    await worker.evaluate(() => chrome.storage.local.set({ focusMode: true }));
    await waitFor("focus mode applying the off-day rule", () => page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color === "rgb(4, 5, 6)"));
    await worker.evaluate(() => chrome.storage.local.set({ focusMode: false }));
    await waitFor("the rule turning back off", () => page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color !== "rgb(4, 5, 6)"));
    assert.equal(counts(server.output()).runs, before);
  });

  await check("an /always command runs once for an origin, including two tabs and a reload", async () => {
    await worker.evaluate(() => chrome.storage.local.set({
      commands: [{ id: "always-dark", name: "Dark", prompt: "dark mode", everywhere: true, appliedOrigins: [], createdAt: Date.now() }],
    }));
    const before = counts(server.output()).chats;
    await Promise.all([
      openDemo(browser, "/demo/dark-none.html"),
      openDemo(browser, "/demo/dark-none.html"),
    ]);
    await waitFor("the always command", async () => counts(server.output()).chats >= before + 1);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(counts(server.output()).chats, before + 1, `chat calls: ${counts(server.output()).chats - before}`);
    const page = browser.context.pages().find((item) => item.url().includes("dark-none"));
    await page?.reload();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(counts(server.output()).chats, before + 1, "reload ran /always again");
  });

  await check("an idle page does not call the model", async () => {
    const before = counts(server.output());
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const after = counts(server.output());
    assert.equal(after.runs, before.runs);
    assert.equal(after.classify, before.classify);
  });

  await check("pause drops saved changes and resume puts them back without a model call", async () => {
    const page = await openDemo(browser, "/demo/campus.html");
    await waitFor("the saved font before pause", async () => (await fontSizeOf(page)) === 22);
    const before = counts(server.output()).runs;
    await worker.evaluate(() => chrome.storage.local.set({ paused: true }));
    await waitFor("pause reverting the font", async () => (await fontSizeOf(page)) !== 22);
    await worker.evaluate(() => chrome.storage.local.set({ paused: false }));
    await waitFor("resume restoring the font", async () => (await fontSizeOf(page)) === 22);
    assert.equal(counts(server.output()).runs, before);
  });

  if (problems.length) throw new Error(problems.join("\n"));
});
