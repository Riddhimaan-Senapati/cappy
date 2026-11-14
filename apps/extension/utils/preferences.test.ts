import { describe, expect, test } from "bun:test";
import { EMPTY_PROFILE, Profile, type GlobalChange, type Need } from "@browser-agent/shared";
import {
  diffPreferences,
  layerIsEmpty,
  mergeChanges,
  parseStore,
  withoutCompiledPreferences,
  type PreferenceEntry,
  type PreferenceStore,
} from "./preferences";

const pref = (id: string, detail: string): Need => ({ id, kind: "preference", detail, source: "onboarding" }) as Need;
const profile = (needs: Need[]): Profile => Profile.parse({ version: 1, summary: "", needs });

const compiled = (change: GlobalChange, summary = "ok"): PreferenceEntry => ({
  detail: "d",
  status: "compiled",
  change,
  summary,
  compiledAt: 1,
});

const darkChange: GlobalChange = { css: "html { filter: invert(1); }", blocks: [], filters: [] };
const shortsChange: GlobalChange = {
  blocks: [{ block: "text_scale", scale: 1.2 }],
  filters: [{ keywords: ["Shorts"], action: "hide" }],
};

describe("diffPreferences", () => {
  test("compiles preference needs that have no entry yet", () => {
    const diff = diffPreferences(profile([pref("a", "prefers dark mode")]), {});
    expect(diff.toCompile.map((n) => n.id)).toEqual(["a"]);
    expect(diff.toRemove).toEqual([]);
  });

  test("ignores non-preference needs", () => {
    const text: Need = { id: "t", kind: "text_size", detail: "bigger text", source: "onboarding" };
    expect(diffPreferences(profile([text]), {}).toCompile).toEqual([]);
  });

  test("recompiles when the detail changed, keeps final statuses, retries errors and pending", () => {
    const store: PreferenceStore = {
      a: { detail: "old", status: "compiled", change: darkChange, summary: "s", compiledAt: 1 },
      b: { detail: "same", status: "none", reason: "r", compiledAt: 1 },
      c: { detail: "same", status: "error", compiledAt: 1 },
      d: { detail: "same", status: "pending", compiledAt: 1 },
    };
    const needs = [pref("a", "new"), pref("b", "same"), pref("c", "same"), pref("d", "same")];
    expect(diffPreferences(profile(needs), store).toCompile.map((n) => n.id)).toEqual(["a", "c", "d"]);
  });

  test("removes entries whose preference left the profile, including ones turned into another kind", () => {
    const store: PreferenceStore = {
      gone: { detail: "x", status: "compiled", change: darkChange, compiledAt: 1 },
      kept: { detail: "y", status: "none", reason: "r", compiledAt: 1 },
    };
    const turned: Need = { id: "kept", kind: "focus", detail: "y", source: "onboarding" };
    expect(diffPreferences(profile([turned]), store).toRemove).toEqual(["gone", "kept"]);
  });

  test("an empty profile has nothing to compile or remove", () => {
    expect(diffPreferences(EMPTY_PROFILE, {})).toEqual({ toCompile: [], toRemove: [] });
  });
});

describe("withoutCompiledPreferences", () => {
  test("drops only compiled preferences for the model", () => {
    const needs = [pref("a", "dark"), pref("b", "no shorts"), pref("c", "tiny text")];
    const store: PreferenceStore = {
      a: { ...compiled(darkChange), detail: "dark" },
      b: { detail: "no shorts", status: "none", reason: "r", compiledAt: 1 },
      c: { detail: "tiny text", status: "pending", compiledAt: 1 },
    };
    const kept = withoutCompiledPreferences(profile(needs), store);
    expect(kept.needs.map((n) => n.id)).toEqual(["b", "c"]);
    expect(kept.version).toBe(1);
  });

  test("keeps a compiled preference whose detail changed since it was compiled", () => {
    const store: PreferenceStore = { a: { ...compiled(darkChange), detail: "old" } };
    expect(withoutCompiledPreferences(profile([pref("a", "new")]), store).needs).toHaveLength(1);
  });
});

describe("mergeChanges", () => {
  test("concatenates css and filters and keeps the first of each block name", () => {
    const store: PreferenceStore = {
      a: compiled(darkChange),
      b: compiled({
        css: "p { color: red; }",
        blocks: [
          { block: "text_scale", scale: 1.5 },
          { block: "stop_motion", pauseMedia: true },
        ],
        filters: [{ keywords: ["news"], action: "dim" }],
      }),
      c: compiled(shortsChange),
    };
    const layer = mergeChanges(store);
    expect(layer.css).toBe("html { filter: invert(1); }\np { color: red; }");
    expect(layer.blocks).toEqual([
      { block: "text_scale", scale: 1.5 },
      { block: "stop_motion", pauseMedia: true },
    ]);
    expect(layer.filters.map((f) => f.keywords[0])).toEqual(["news", "Shorts"]);
  });

  test("uses only compiled entries", () => {
    const store: PreferenceStore = {
      a: { detail: "x", status: "none", reason: "r", compiledAt: 1 },
      b: { detail: "y", status: "error", compiledAt: 1 },
      c: { detail: "z", status: "pending", compiledAt: 1 },
    };
    const layer = mergeChanges(store);
    expect(layer.css).toBeUndefined();
    expect(layerIsEmpty(layer)).toBe(true);
  });

  test("leaves css out when no compiled change has any", () => {
    const layer = mergeChanges({ a: compiled(shortsChange) });
    expect(layer).not.toHaveProperty("css");
    expect(layerIsEmpty(layer)).toBe(false);
  });
});

describe("parseStore", () => {
  test("keeps valid entries and drops malformed or unsafe ones", () => {
    const store = parseStore({
      good: { detail: "dark", status: "compiled", change: darkChange, summary: "s", compiledAt: 1 },
      bad: { detail: "", status: "weird" },
      unsafe: {
        detail: "x",
        status: "compiled",
        change: { css: "@import url(x);", blocks: [], filters: [] },
        compiledAt: 1,
      },
    });
    expect(Object.keys(store)).toEqual(["good"]);
    expect(parseStore(undefined)).toEqual({});
    expect(parseStore([])).toEqual({});
  });
});
