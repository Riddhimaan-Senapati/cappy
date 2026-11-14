import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseTarget, mentionsTarget } from "../extension/src/voice/point.js";

const camera = (value: string) => ({ value, deliberate: true });
const mouse = (value: string) => ({ value, deliberate: false });

test("mentionsTarget spots words that point at something", () => {
  for (const text of ["make this red", "Hide that", "bigger here", "make these bold", "can you move it up"]) assert.ok(mentionsTarget(text), text);
  for (const text of ["make the text bigger", "turn on dark mode", "within reason"]) assert.equal(mentionsTarget(text), false, text);
});

test("the camera pointer counts on its own, the mouse only with a pointing word", () => {
  assert.equal(chooseTarget("make it bigger", null, camera("button")), "button");
  assert.equal(chooseTarget("bigger please", camera("button"), null), "button");
  assert.equal(chooseTarget("make the text bigger", mouse("p"), mouse("p")), null);
  assert.equal(chooseTarget("make this red", mouse("h1"), null), "h1");
});

test("what was pointed at when speaking started wins over where the pointer ended", () => {
  assert.equal(chooseTarget("make this red", camera("logo"), camera("nav")), "logo");
  assert.equal(chooseTarget("make this red", null, mouse("nav")), "nav");
  assert.equal(chooseTarget("make this red", null, null), null);
});
