import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ActiveChange, Change } from "../shared/adaptation.js";
import { DEFAULTS, load, recipeKey, recordApplied, recordReverted, saveRecipe, savedChangesFor } from "../extension/src/storage.js";
import { replyAfterTools } from "../server/agent/session.js";
import { changesWithDarkModeLast, prepareSavedChange, savedChangeOnThisPage } from "../shared/validate.js";

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

    const oneOffs = ["dark mode", "make the text bigger", "stop motion"] as const;
    for (const message of oneOffs) {
      const saved = prepareSavedChange({ ...text, scope: "everywhere" }, message, "chat", "/demo/campus.html");
      assert.equal(saved.scope, "page", message);
      assert.equal(saved.pagePath, "/demo/campus.html");
    }
    assert.equal(prepareSavedChange({ ...dark, scope: "everywhere" }, "dark mode everywhere", "chat", "/demo/campus.html").scope, "everywhere");
    assert.equal(prepareSavedChange({ ...dark, scope: "everywhere" }, "dark mode on this site", "chat", "/demo/campus.html").scope, "site");
    assert.equal(prepareSavedChange({ ...dark, scope: "everywhere" }, "dark mode everywhere on youtube.com", "chat", "/demo/campus.html").scope, "site");
    assert.equal(prepareSavedChange({ ...text, scope: "everywhere" }, "make the text bigger across all websites", "chat", "/demo/campus.html").scope, "everywhere");
    assert.equal(prepareSavedChange({ ...dark, scope: "site" }, "dark mode everywhere on the web", "chat", "/demo/campus.html").scope, "everywhere");
    assert.equal(prepareSavedChange({ ...dark, scope: "everywhere" }, "dark mode everywhere on this page", "chat", "/demo/campus.html").scope, "page");
    assert.equal(prepareSavedChange({ ...text, scope: "everywhere" }, "make the text bigger across the whole site, not just on this page", "chat", "/demo/campus.html").scope, "site");
    assert.equal(prepareSavedChange({ ...text, scope: "everywhere" }, "bigger text everywhere, not just on this page", "chat", "/demo/campus.html").scope, "everywhere");
    assert.equal(prepareSavedChange({ ...dark, scope: "everywhere", schedule: { start: "22:00", end: "06:00" } }, "dark mode on this page after 10pm", "chat", "/demo/campus.html").scope, "page");
    const weekdays = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };
    const portable = prepareSavedChange(
      { ...text, scope: "everywhere", schedule: weekdays, block: { name: "contentFilter", keywords: ["shorts"], itemSelector: null, action: "hide" } },
      "hide Shorts on weekdays 9 to 5",
      "chat",
      "/demo/campus.html",
    );
    assert.equal(portable.scope, "everywhere");
    const hosted = prepareSavedChange(
      { ...text, scope: "everywhere", schedule: weekdays, block: { name: "contentFilter", keywords: ["shorts"], itemSelector: "ytd-rich-item-renderer", action: "hide" } },
      "hide Shorts on weekdays 9 to 5",
      "chat",
      "/demo/campus.html",
    );
    assert.equal(hosted.scope, "site");
  });

  it("restores dark mode after CSS so an already-dark page is not inverted", () => {
    const css = { id: "dim", block: null };
    const dark = { id: "dark-mode", block: { name: "darkMode" } };
    assert.deepEqual(changesWithDarkModeLast([dark, css, { id: "motion", block: { name: "stopMotion" } }]).map((change) => change.id), ["dim", "motion", "dark-mode"]);
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

describe("a no-op does not get to claim it changed the page", () => {
  it("replaces the reply when nothing was applied", () => {
    assert.equal(replyAfterTools("I have enabled dark mode across all websites.", 0, ["The page is already dark."]), "The page is already dark.");
    assert.equal(replyAfterTools("Dimmed the page.", 1, ["The page is already dark."]), "Dimmed the page.");
    assert.equal(replyAfterTools("Done.", 0, []), "Done.");
  });
});
