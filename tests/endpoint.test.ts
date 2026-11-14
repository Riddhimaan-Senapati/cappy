import { test } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINT, startEndpoint, stepEndpoint, stripDoneKeyword, type EndpointSignal } from "../extension/src/voice/endpoint.js";

const QUIET = 0.005;
const LOUD = 0.2;

// Feeds one level every 50 ms and records every signal with its time.
function run(levels: Array<[number, number]>, hold = false) {
  let state = startEndpoint(0);
  const signals: Array<{ at: number; signal: NonNullable<EndpointSignal> }> = [];
  let at = 0;
  for (const [level, ms] of levels) {
    for (const end = at + ms; at < end; at += 50) {
      const step = stepEndpoint(state, level, at, hold);
      state = step.state;
      if (step.signal) signals.push({ at, signal: step.signal });
      if (step.signal?.type === "stop") return signals;
    }
  }
  return signals;
}

test("a pause after speech starts the countdown and then stops", () => {
  const signals = run([[QUIET, 500], [LOUD, 1000], [QUIET, 3000]]);
  assert.deepEqual(signals.map(({ signal }) => signal.type), ["pause", "stop"]);
  assert.deepEqual(signals[0].signal, { type: "pause", ms: ENDPOINT.pauseMs });
  assert.equal(signals[1].at - signals[0].at, ENDPOINT.pauseMs);
  assert.deepEqual(signals[1].signal, { type: "stop", reason: "pause" });
});

test("speaking again during the pause cancels the countdown", () => {
  const signals = run([[LOUD, 800], [QUIET, 600], [LOUD, 800], [QUIET, 3000]]);
  assert.deepEqual(signals.map(({ signal }) => signal.type), ["pause", "resume", "pause", "stop"]);
});

test("stops when nothing is said, and at the 15 second cap even mid-sentence", () => {
  assert.deepEqual(run([[QUIET, 10_000]]).at(-1)?.signal, { type: "stop", reason: "no-speech" });
  const capped = run([[LOUD, 20_000]]);
  assert.deepEqual(capped.at(-1), { at: ENDPOINT.maxMs, signal: { type: "stop", reason: "max" } });
});

test("a steady background hum raises the noise floor instead of counting as speech", () => {
  assert.deepEqual(run([[0.015, 4000], [0.016, 3000]]).at(-1)?.signal, { type: "stop", reason: "no-speech" });
});

test("rising microphone gain after the user stops still counts as a pause", () => {
  const signals = run([[QUIET, 400], [LOUD, 1200], [0.04, 400], [0.06, 3000]]);
  assert.deepEqual(signals.map(({ signal }) => signal.type), ["pause", "stop"]);
});

test("steady noise that is there from the start does not hide the pause after speech", () => {
  const signals = run([[0.045, 2000], [0.3, 1200], [0.05, 4000]]);
  assert.deepEqual(signals.at(-1)?.signal, { type: "stop", reason: "pause" });
});

test("a quieter second sentence still keeps listening", () => {
  const signals = run([[LOUD, 1000], [QUIET, 500], [0.1, 1000], [QUIET, 3000]]);
  assert.deepEqual(signals.map(({ signal }) => signal.type), ["pause", "resume", "pause", "stop"]);
});

test("while holding a pinch, pauses and silence never stop listening; only the cap does", () => {
  const signals = run([[LOUD, 800], [QUIET, 5000], [LOUD, 500], [QUIET, 12_000]], true);
  assert.ok(signals.every(({ signal }) => signal.type !== "pause"));
  assert.deepEqual(signals.at(-1)?.signal, { type: "stop", reason: "max" });
});

test("stripDoneKeyword ends on a trailing done or send it, and keeps the rest", () => {
  assert.deepEqual(stripDoneKeyword("make this red done"), { text: "make this red", done: true });
  assert.deepEqual(stripDoneKeyword("Make the header bigger, done."), { text: "Make the header bigger", done: true });
  assert.deepEqual(stripDoneKeyword("hide the sidebar send it"), { text: "hide the sidebar", done: true });
  assert.deepEqual(stripDoneKeyword("mark done items in green"), { text: "mark done items in green", done: false });
  assert.deepEqual(stripDoneKeyword("make this button say send"), { text: "make this button say send", done: false });
  assert.deepEqual(stripDoneKeyword("  make it bigger "), { text: "make it bigger", done: false });
});
