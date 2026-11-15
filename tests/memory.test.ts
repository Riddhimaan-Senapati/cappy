import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptMemory, addMemoryLines, editMemoryLine, forgetMemory, lineSite, normalizeMemoryLine, profileFor, receiveMemory, rejectMemory } from "../extension/src/memory.js";

test("normalizeMemoryLine trims, collapses whitespace and caps length", () => {
  assert.equal(normalizeMemoryLine("  Prefers   dark\tmode  "), "Prefers dark mode");
  assert.equal(normalizeMemoryLine("x".repeat(300)).length, 140);
});

test("addMemoryLines dedupes case-insensitively and skips blanks", () => {
  assert.deepEqual(addMemoryLines(["Prefers dark mode"], ["prefers  DARK mode", "", "Red-green colorblind", "Red-green colorblind"]), [
    "Prefers dark mode",
    "Red-green colorblind",
  ]);
});

const site = { host: "news.example", scope: "everywhere" as const };
const empty = { pendingSites: {} };

test("receiveMemory always proposes new lines and remembers where they came from", () => {
  const decision = receiveMemory({ profile: ["A"], pendingMemory: [], ...empty }, ["B", "a"], site);
  assert.deepEqual(decision.profile, ["A"]);
  assert.deepEqual(decision.pendingMemory, ["B"]);
  assert.deepEqual(decision.proposed, ["B"]);
  assert.deepEqual(decision.pendingSites, { b: site });
});

test("receiveMemory keeps only the latest unanswered proposals", () => {
  const incoming = Array.from({ length: 10 }, (_, index) => `Line ${index}`);
  const decision = receiveMemory({ profile: [], pendingMemory: [], ...empty }, incoming, site);
  assert.equal(decision.pendingMemory.length, 8);
  assert.equal(decision.pendingMemory[0], "Line 2");
  assert.equal(decision.pendingMemory.at(-1), "Line 9");
  assert.equal(decision.pendingSites["line 0"], undefined);
  assert.ok(decision.pendingSites["line 9"]);
  assert.deepEqual(decision.proposed, incoming.slice(2));
});

test("receiveMemory ignores lines already saved, saved for this site, or already proposed", () => {
  const decision = receiveMemory({ profile: ["A", "On news.example: D"], pendingMemory: ["B"], ...empty }, ["a", "b", "C", "d"], site);
  assert.deepEqual(decision.pendingMemory, ["B", "C"]);
  assert.deepEqual(decision.proposed, ["C"]);
});

test("accepting for all sites saves the plain line; for this site it adds the host prefix", () => {
  const state = { profile: ["A"], pendingMemory: ["B", "C"], pendingSites: { b: site, c: site } };
  assert.deepEqual(acceptMemory(state, "B", "everywhere"), { profile: ["A", "B"], pendingMemory: ["C"], pendingSites: { c: site } });
  assert.deepEqual(acceptMemory(state, "C", "site").profile, ["A", "On news.example: C"]);
});

test("reject drops a proposal and its origin", () => {
  const state = { profile: ["A"], pendingMemory: ["B", "C"], pendingSites: { c: site } };
  assert.deepEqual(rejectMemory(state, "C"), { profile: ["A"], pendingMemory: ["B"], pendingSites: {} });
});

test("accepting a line already in the profile does not duplicate it", () => {
  assert.deepEqual(acceptMemory({ profile: ["A"], pendingMemory: ["a"], ...empty }, "a", "everywhere"), { profile: ["A"], pendingMemory: [], pendingSites: {} });
});

test("profileFor sends site-only lines to their own host and nowhere else", () => {
  const profile = ["Prefers dark mode", "On news.example: Hide podcasts", "On video.example: No Shorts"];
  assert.deepEqual(profileFor(profile, "news.example"), ["Prefers dark mode", "On news.example: Hide podcasts"]);
  assert.deepEqual(profileFor(profile, "NEWS.example"), ["Prefers dark mode", "On news.example: Hide podcasts"]);
  assert.deepEqual(profileFor(profile, "other.example"), ["Prefers dark mode"]);
  assert.equal(lineSite("On localhost:8787: Bigger text"), "localhost:8787");
});

test("forgetMemory removes a saved line and leaves proposals alone", () => {
  assert.deepEqual(forgetMemory({ profile: ["A", "B"], pendingMemory: ["C"], pendingSites: {} }, "b"), { profile: ["A"], pendingMemory: ["C"], pendingSites: {} });
});

test("editMemoryLine replaces, deletes when blank, and dedupes against other lines", () => {
  assert.deepEqual(editMemoryLine(["A", "B"], 1, " New  line "), ["A", "New line"]);
  assert.deepEqual(editMemoryLine(["A", "B"], 1, "   "), ["A"]);
  assert.deepEqual(editMemoryLine(["A", "B"], 1, "a"), ["A"]);
});
