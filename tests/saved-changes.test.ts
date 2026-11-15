import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ActiveChange, Change } from "../shared/adaptation.js";
import { DEFAULTS, load, recipeKey, recordApplied, recordReverted, rescopeStoredChanges, saveRecipe, savedChangesFor, scopeForPrompt } from "../extension/src/storage.js";
import { prepareSavedChange, savedChangeOnThisPage } from "../shared/validate.js";

const originalChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = originalChrome;
});

function storage(initial: Record<string, unknown> = {}) {
  const data = structuredClone({ ...DEFAULTS, ...initial });
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => data,
        set: async (patch: Record<string, unknown>) => {
          Object.assign(data, patch);
        },
      },
    },
  } as unknown as typeof chrome;
  return data;
}

const origin = "http://localhost:8787";

function saved(id: string, summary: string, scope: ActiveChange["scope"], pagePath?: string, block?: ActiveChange["block"]): ActiveChange {
  return {
    id,
    summary,
    reason: "Request",
    css: null,
    dom: null,
    block: block ?? null,
    scope,
    appliedAt: 1,
    ...(pagePath ? { pagePath } : {}),
  };
}

describe("saved changes stay on the page that was asked", () => {
  it("does not restore a one-off dark mode or text change onto a different page of the same origin", async () => {
    storage();
    await recordApplied(origin, saved("dark-mode", "Dark mode", "page", "/demo/dark-none.html", { name: "darkMode", allowSiteControls: true }));
    await recordApplied(origin, saved("bigger-text", "Larger text (130%)", "page", "/demo/campus.html", { name: "textScale", scale: 1.3 }));
    await recordApplied(origin, saved("hide-shorts", "Hiding shorts", "site", undefined, { name: "contentFilter", keywords: ["shorts"], itemSelector: "ytd-rich-item-renderer", action: "hide" }));

    const form = await savedChangesFor(origin, "/demo/form.html");
    const trap = await savedChangesFor(origin, "/demo/trap.html");
    const darkPage = await savedChangesFor(origin, "/demo/dark-none.html");
    const campus = await savedChangesFor(origin, "/demo/campus.html");

    assert.deepEqual(form.map((change) => change.id), ["hide-shorts"]);
    assert.deepEqual(trap.map((change) => change.id), ["hide-shorts"]);
    assert.deepEqual(darkPage.map((change) => change.id).sort(), ["dark-mode", "hide-shorts"]);
    assert.deepEqual(campus.map((change) => change.id).sort(), ["bigger-text", "hide-shorts"]);
    assert.equal(form.some((change) => change.block?.name === "darkMode"), false);
    assert.equal(form.some((change) => change.block?.name === "textScale"), false);
  });
});

describe("one-off scope is the same for every change type", () => {
  const base = (id: string, block: Change["block"]): Change => ({
    id, summary: id, reason: "Request", css: null, dom: null, block, scope: "site",
  });

  it("keeps dark mode and larger text on this page unless the user asked for the site", () => {
    const dark = base("dark-mode", { name: "darkMode", allowSiteControls: true });
    const text = base("bigger-text", { name: "textScale", scale: 1.3 });
    const darkPage = prepareSavedChange(dark, "dark mode", "chat", "/demo/dark-none.html");
    const textPage = prepareSavedChange(text, "make the text bigger", "chat", "/demo/campus.html");
    assert.equal(darkPage.scope, "page");
    assert.equal(textPage.scope, "page");
    assert.equal(darkPage.pagePath, "/demo/dark-none.html");
    assert.equal(textPage.pagePath, "/demo/campus.html");
    assert.equal(darkPage.id, "dark-mode");
    assert.equal(textPage.id, "bigger-text");
    assert.equal(savedChangeOnThisPage(darkPage, "/demo/form.html"), false);
    assert.equal(savedChangeOnThisPage(textPage, "/demo/form.html"), false);
    assert.equal(savedChangeOnThisPage(darkPage, "/demo/dark-none.html"), true);

    const acrossSite = prepareSavedChange(dark, "dark mode on this website", "chat", "/demo/dark-none.html");
    assert.equal(acrossSite.scope, "site");
    assert.equal(acrossSite.pagePath, undefined);
    assert.equal(savedChangeOnThisPage(acrossSite, "/demo/form.html"), true);

    const scheduled = prepareSavedChange(
      { ...text, schedule: { days: ["mon"], start: "09:00", end: "17:00" } },
      "make the text bigger",
      "chat",
      "/demo/campus.html",
    );
    assert.equal(scheduled.scope, "site");

    const everywhere = prepareSavedChange({ ...text, scope: "everywhere" }, "I prefer larger text", "chat", "/demo/campus.html");
    assert.equal(everywhere.scope, "everywhere");
    assert.equal(prepareSavedChange(dark, "dark mode", "page_load", "/demo/form.html").scope, "site");
  });

  it("refuses to apply a page-scoped change on a different document", async () => {
    const { installDom } = await import("./dom-setup.js");
    installDom();
    if (typeof location === "undefined") {
      Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
    }
    if (typeof document.getAnimations !== "function") {
      Object.defineProperty(document, "getAnimations", { value: () => [], configurable: true });
    }
    if (typeof matchMedia !== "function") {
      Object.defineProperty(globalThis, "matchMedia", {
        value: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} }),
        configurable: true,
      });
    }
    const { applyChange } = await import("../extension/src/content/engine.js");
    document.body.innerHTML = "<p id='copy'>Hello</p>";
    const elsewhere: Change = {
      id: "bigger-text",
      summary: "Larger text (130%)",
      reason: "Request",
      css: null,
      dom: null,
      block: { name: "textScale", scale: 1.3 },
      scope: "page",
      pagePath: "/demo/campus.html",
    };
    const blocked = await applyChange(elsewhere, false);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /different page/);
    assert.equal(document.getElementById("copy")?.getAttribute("style"), null);

    const here: Change = { ...elsewhere, id: "bigger-text-here", pagePath: location.pathname };
    const applied = await applyChange(here, false);
    assert.equal(applied.ok, true, applied.error ?? "apply failed");
    assert.ok(document.getElementById("copy")?.style.fontSize);
  });
});

describe("undo drops the saved change and its recipe", () => {
  it("removes the change and the recipe so the next plain Enter cannot replay it", async () => {
    const data = storage();
    const change = saved("bigger-text", "Larger text (130%)", "page", "/demo/campus.html", { name: "textScale", scale: 1.3 });
    await recordApplied(origin, change);
    const key = recipeKey(origin, "make the text bigger");
    await saveRecipe(key, { message: "make the text bigger", changes: [change], at: 1 });
    await saveRecipe(recipeKey("http://127.0.0.1:8787", "make the text bigger"), {
      message: "make the text bigger",
      changes: [change],
      at: 2,
    });

    await recordReverted(origin, change.id);

    const state = await load();
    assert.equal(state.recipes[key], undefined);
    assert.equal(state.siteChanges[origin], undefined);
    assert.equal(state.globalChanges.some((item) => item.id === change.id), false);
    assert.ok(state.recipes[recipeKey("http://127.0.0.1:8787", "make the text bigger")], "a recipe saved on another origin stays");
    assert.equal(data.recipes[key], undefined);
  });
});

describe("the save prompt moves the change with the answer", () => {
  it("moves an everywhere change onto this site when the user picks only this site", async () => {
    storage();
    await recordApplied(origin, saved("bigger-text", "Larger text", "everywhere", undefined, { name: "textScale", scale: 1.3 }));
    await rescopeStoredChanges(origin, ["bigger-text"], "site", "/demo/campus.html");
    const state = await load();
    assert.equal(state.globalChanges.length, 0);
    assert.equal(state.siteChanges[origin]?.[0]?.scope, "site");
    assert.equal(state.siteChanges[origin]?.[0]?.pagePath, undefined);
  });

  it("leaves another site's change alone when the id is the same", async () => {
    storage();
    const other = "https://news.ycombinator.com";
    await recordApplied(origin, saved("dark-mode", "Dark mode", "site", undefined, { name: "darkMode", allowSiteControls: true }));
    await recordApplied(other, saved("dark-mode", "Dark mode", "site", undefined, { name: "darkMode", allowSiteControls: true }));
    await rescopeStoredChanges(origin, ["dark-mode"], "site", "/demo/campus.html");
    const state = await load();
    assert.equal(state.siteChanges[origin]?.length, 1);
    assert.equal(state.siteChanges[origin]?.[0]?.scope, "site");
    assert.equal(state.siteChanges[other]?.[0]?.scope, "site");
  });

  it("holds an all-sites preference on this page, and does not publish site-specific CSS everywhere", async () => {
    const text = saved("bigger-text", "Larger text", "everywhere", undefined, { name: "textScale", scale: 1.3 });
    const css = { ...saved("dim", "Dim", "everywhere"), css: "body { filter: brightness(0.9); }", block: null };
    const shorts = saved("hide-shorts", "Hide Shorts", "site", undefined, { name: "contentFilter", keywords: ["shorts"], itemSelector: "ytd-rich-item-renderer", action: "hide", match: null });
    assert.equal(scopeForPrompt(text, "hold"), "page");
    assert.equal(scopeForPrompt(css, "hold"), "page");
    assert.equal(scopeForPrompt(shorts, "hold"), null);
    assert.equal(scopeForPrompt(css, "everywhere"), "site");
    assert.equal(scopeForPrompt({ ...shorts, schedule: { days: ["mon"], start: "09:00", end: "17:00" } }, "everywhere"), "site");
  });

  it("updates the saved recipe when the prompt changes where the change applies", async () => {
    storage();
    const change = saved("bigger-text", "Larger text", "everywhere", undefined, { name: "textScale", scale: 1.3 });
    await recordApplied(origin, change);
    await saveRecipe(recipeKey(origin, "make the text bigger"), { message: "make the text bigger", changes: [change], at: 1 });
    await rescopeStoredChanges(origin, ["bigger-text"], "site", "/demo/campus.html");
    const state = await load();
    assert.equal(state.recipes[recipeKey(origin, "make the text bigger")]?.changes[0]?.scope, "site");
  });

  it("does not demote an all-sites change this run did not write", async () => {
    storage();
    await recordApplied(origin, saved("bigger-text", "Larger text", "everywhere", undefined, { name: "textScale", scale: 1.3 }));
    await rescopeStoredChanges(origin, [{ id: "bigger-text", appliedAt: 9 }], "hold", "/demo/campus.html");
    const state = await load();
    assert.equal(state.globalChanges[0]?.scope, "everywhere");
    assert.equal(state.siteChanges[origin], undefined);
  });

  it("keeps a one-off on this page when all sites is answered for a different change", async () => {
    storage();
    await recordApplied(origin, saved("dark-mode", "Dark mode", "page", "/demo/campus.html", { name: "darkMode", allowSiteControls: true }));
    await recordApplied(origin, saved("bigger-text", "Larger text", "everywhere", undefined, { name: "textScale", scale: 1.3 }));
    const held = await rescopeStoredChanges(origin, [{ id: "dark-mode", appliedAt: 1 }, { id: "bigger-text", appliedAt: 1 }], "hold", "/demo/campus.html");
    assert.deepEqual(held.map((update) => update.id), ["bigger-text"]);
    await rescopeStoredChanges(origin, held.map((update) => ({ id: update.id, appliedAt: 1 })), "everywhere", "/demo/campus.html");
    const state = await load();
    assert.equal(state.siteChanges[origin]?.find((change) => change.id === "dark-mode")?.scope, "page");
    assert.equal(state.globalChanges.find((change) => change.id === "bigger-text")?.scope, "everywhere");
  });

  it("keeps a recipe that is saved while the prompt is still holding", async () => {
    storage();
    const change = saved("bigger-text", "Larger text", "everywhere", undefined, { name: "textScale", scale: 1.3 });
    await recordApplied(origin, change);
    const key = recipeKey(origin, "make the text bigger");
    await Promise.all([
      rescopeStoredChanges(origin, [{ id: "bigger-text", appliedAt: 1 }], "hold", "/demo/campus.html"),
      saveRecipe(key, { message: "make the text bigger", changes: [change], at: 5 }),
    ]);
    const state = await load();
    assert.equal(state.globalChanges.length, 0);
    assert.equal(state.siteChanges[origin]?.[0]?.scope, "page");
    assert.equal(state.recipes[key]?.changes[0]?.scope, "page");
  });
});
