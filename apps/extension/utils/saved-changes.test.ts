import { expect, test } from "bun:test";
import { Adaptation } from "@browser-agent/shared";
import { MAX_SAVED_HOSTS, forget, lookup, parseSaved, remember, stripOps, type SavedChanges } from "./saved-changes";

const textSize = Adaptation.parse({
  id: "a1",
  sites: ["example.com"],
  reason: { text: "Larger text for reading", needId: "n1" },
  blocks: [{ block: "text_focus", fontScale: 1.25, lineHeight: 1.5, font: "system", hide: [] }],
});

const withOps = Adaptation.parse({
  id: "a2",
  sites: ["*.example.com"],
  reason: { text: "Hide the ads", needId: "n2" },
  blocks: [],
  css: "html { font-size: 20px; }",
  ops: [{ op: "hide", ids: ["n3"] }],
});

test("returns the adaptation when host and profile version match", () => {
  const saved = remember({}, "example.com", textSize, 3, 1);
  expect(lookup(saved, "example.com", 3)?.id).toBe("a1");
});

test("ignores the entry once the profile version changed", () => {
  const saved = remember({}, "example.com", textSize, 3, 1);
  expect(lookup(saved, "example.com", 4)).toBeUndefined();
});

test("ignores the entry for a host the adaptation does not cover", () => {
  const saved: SavedChanges = remember({}, "example.com", textSize, 3, 1);
  saved["other.org"] = saved["example.com"]!;
  expect(lookup(saved, "other.org", 3)).toBeUndefined();
});

test("matches wildcard sites and ignores host case", () => {
  const saved = remember({}, "shop.example.com", withOps, 1, 1);
  expect(lookup(saved, "Shop.Example.com", 1)?.id).toBe("a2");
});

test("strips snapshot ops before saving but keeps css and blocks", () => {
  const saved = remember({}, "shop.example.com", withOps, 1, 1);
  const stored = saved["shop.example.com"]!.adaptation;
  expect(stored.ops).toBeUndefined();
  expect(stored.css).toBe("html { font-size: 20px; }");
  expect(stripOps(withOps).ops).toBeUndefined();
  expect(withOps.ops?.length).toBe(1);
});

test("keeps content filters when saving, since their selectors are stable across visits", () => {
  const filtered = Adaptation.parse({
    id: "a3",
    sites: ["youtube.com"],
    reason: { text: "Remove podcasts from the feed", needId: "n4" },
    blocks: [],
    ops: [{ op: "hide", ids: ["n9"] }],
    filters: [{ itemSelector: "ytd-rich-item-renderer", keywords: ["podcast"], action: "hide" }],
  });
  const saved = remember({}, "youtube.com", filtered, 1, 1);
  expect(saved["youtube.com"]!.adaptation.filters).toEqual(filtered.filters);
  expect(saved["youtube.com"]!.adaptation.ops).toBeUndefined();
});

test("does not save an adaptation that is empty once ops are stripped", () => {
  const onlyOps = Adaptation.parse({
    id: "a3",
    sites: ["example.com"],
    reason: { text: "Hide the ads", needId: "n2" },
    blocks: [],
    ops: [{ op: "hide", ids: ["n3"] }],
  });
  const saved = remember(remember({}, "example.com", textSize, 1, 1), "example.com", onlyOps, 1, 2);
  expect(saved["example.com"]).toBeUndefined();
});

test("forget removes only the given host", () => {
  let saved = remember({}, "example.com", textSize, 1, 1);
  saved = remember(saved, "shop.example.com", withOps, 1, 1);
  const next = forget(saved, "Example.com");
  expect(Object.keys(next)).toEqual(["shop.example.com"]);
});

test("caps the saved hosts and drops the oldest", () => {
  let saved: SavedChanges = {};
  for (let i = 0; i < MAX_SAVED_HOSTS + 5; i++) {
    saved = remember(saved, `site${i}.example.com`, textSize, 1, i);
  }
  expect(Object.keys(saved).length).toBe(MAX_SAVED_HOSTS);
  expect(saved["site0.example.com"]).toBeUndefined();
  expect(saved[`site${MAX_SAVED_HOSTS + 4}.example.com`]).toBeDefined();
});

test("parseSaved keeps valid entries and drops broken ones", () => {
  const good = remember({}, "example.com", textSize, 1, 1)["example.com"];
  const parsed = parseSaved({ "example.com": good, "bad.com": { adaptation: 1 }, nope: "x" });
  expect(Object.keys(parsed)).toEqual(["example.com"]);
  expect(parseSaved("junk")).toEqual({});
});
