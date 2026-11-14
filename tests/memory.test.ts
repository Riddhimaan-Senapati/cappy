import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptMemory, addMemoryLines, editMemoryLine, forgetMemory, normalizeMemoryLine, receiveMemory, rejectMemory } from "../extension/src/memory.ts";

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

test("receiveMemory saves straight to the profile when askBeforeRemember is off", () => {
  const decision = receiveMemory({ profile: ["A"], pendingMemory: [], askBeforeRemember: false }, ["B", "a"]);
  assert.deepEqual(decision.profile, ["A", "B"]);
  assert.deepEqual(decision.pendingMemory, []);
  assert.deepEqual(decision.saved, ["B"]);
  assert.deepEqual(decision.proposed, []);
});

test("receiveMemory only proposes when askBeforeRemember is on", () => {
  const decision = receiveMemory({ profile: ["A"], pendingMemory: [], askBeforeRemember: true }, ["B"]);
  assert.deepEqual(decision.profile, ["A"]);
  assert.deepEqual(decision.pendingMemory, ["B"]);
  assert.deepEqual(decision.saved, []);
  assert.deepEqual(decision.proposed, ["B"]);
});

test("receiveMemory ignores lines already saved or already proposed", () => {
  const decision = receiveMemory({ profile: ["A"], pendingMemory: ["B"], askBeforeRemember: true }, ["a", "b", "C"]);
  assert.deepEqual(decision.pendingMemory, ["B", "C"]);
  assert.deepEqual(decision.proposed, ["C"]);
});

test("accept moves a proposal into the profile, reject drops it", () => {
  const state = { profile: ["A"], pendingMemory: ["B", "C"] };
  const accepted = acceptMemory(state, "B");
  assert.deepEqual(accepted, { profile: ["A", "B"], pendingMemory: ["C"] });
  const rejected = rejectMemory(state, "C");
  assert.deepEqual(rejected, { profile: ["A"], pendingMemory: ["B"] });
});

test("accepting a line already in the profile does not duplicate it", () => {
  assert.deepEqual(acceptMemory({ profile: ["A"], pendingMemory: ["a"] }, "a"), { profile: ["A"], pendingMemory: [] });
});

test("forgetMemory removes a saved line and leaves proposals alone", () => {
  assert.deepEqual(forgetMemory({ profile: ["A", "B"], pendingMemory: ["C"] }, "b"), { profile: ["A"], pendingMemory: ["C"] });
});

test("editMemoryLine replaces, deletes when blank, and dedupes against other lines", () => {
  assert.deepEqual(editMemoryLine(["A", "B"], 1, " New  line "), ["A", "New line"]);
  assert.deepEqual(editMemoryLine(["A", "B"], 1, "   "), ["A"]);
  assert.deepEqual(editMemoryLine(["A", "B"], 1, "a"), ["A"]);
});
