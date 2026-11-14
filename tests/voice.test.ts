import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VOICE_IDLE,
  isVoiceActive,
  joinVoiceText,
  parseVoiceEvent,
  reduceVoice,
  voiceErrorText,
  voiceStatusText,
  type VoiceState,
} from "../extension/src/voice/core.js";

const at = (phase: VoiceState["phase"], error?: string): VoiceState => (error ? { phase, error } : { phase });

describe("reduceVoice", () => {
  it("starts from idle and from error, never from an active phase", () => {
    assert.equal(reduceVoice(VOICE_IDLE, { type: "start" }).phase, "starting");
    assert.equal(reduceVoice(at("error", "network"), { type: "start" }).phase, "starting");
    assert.equal(reduceVoice(at("listening"), { type: "start" }).phase, "listening");
    assert.equal(reduceVoice(at("stopping"), { type: "start" }).phase, "stopping");
  });

  it("walks the happy path idle, starting, listening, stopping, idle", () => {
    let state = VOICE_IDLE;
    state = reduceVoice(state, { type: "start" });
    assert.equal(state.phase, "starting");
    state = reduceVoice(state, { type: "listening" });
    assert.equal(state.phase, "listening");
    state = reduceVoice(state, { type: "stop" });
    assert.equal(state.phase, "stopping");
    state = reduceVoice(state, { type: "ended" });
    assert.deepEqual(state, VOICE_IDLE);
  });

  it("stops from starting or listening only", () => {
    assert.equal(reduceVoice(at("starting"), { type: "stop" }).phase, "stopping");
    assert.equal(reduceVoice(at("listening"), { type: "stop" }).phase, "stopping");
    assert.equal(reduceVoice(VOICE_IDLE, { type: "stop" }).phase, "idle");
    assert.equal(reduceVoice(at("stopping"), { type: "stop" }).phase, "stopping");
  });

  it("only moves to listening from starting", () => {
    assert.equal(reduceVoice(at("idle"), { type: "listening" }).phase, "idle");
    assert.equal(reduceVoice(at("stopping"), { type: "listening" }).phase, "stopping");
  });

  it("keeps the error until the user starts again, even after the session ends", () => {
    const failed = reduceVoice(at("listening"), { type: "error", error: "not-allowed" });
    assert.deepEqual(failed, { phase: "error", error: "not-allowed" });
    assert.deepEqual(reduceVoice(failed, { type: "ended" }), failed);
    assert.deepEqual(reduceVoice(failed, { type: "start" }), { phase: "starting" });
  });

  it("ignores text events for the phase", () => {
    const listening = at("listening");
    assert.equal(reduceVoice(listening, { type: "interim", text: "hello" }), listening);
    assert.equal(reduceVoice(listening, { type: "final", text: "hello" }), listening);
  });

  it("reports active phases", () => {
    assert.equal(isVoiceActive(VOICE_IDLE), false);
    assert.equal(isVoiceActive(at("error", "network")), false);
    assert.equal(isVoiceActive(at("starting")), true);
    assert.equal(isVoiceActive(at("listening")), true);
    assert.equal(isVoiceActive(at("stopping")), true);
  });
});

describe("parseVoiceEvent", () => {
  it("accepts the five event shapes", () => {
    assert.deepEqual(parseVoiceEvent({ type: "listening" }), { type: "listening" });
    assert.deepEqual(parseVoiceEvent({ type: "ended" }), { type: "ended" });
    assert.deepEqual(parseVoiceEvent({ type: "interim", text: "make it" }), { type: "interim", text: "make it" });
    assert.deepEqual(parseVoiceEvent({ type: "final", text: "make it bigger" }), { type: "final", text: "make it bigger" });
    assert.deepEqual(parseVoiceEvent({ type: "error", error: "no-speech" }), { type: "error", error: "no-speech" });
  });

  it("rejects non-objects, unknown types and missing fields", () => {
    for (const bad of [null, undefined, "final", 42, [], {}, { type: "explode" }, { type: "interim" }, { type: "final", text: 7 }, { type: "error" }]) {
      assert.equal(parseVoiceEvent(bad), null, JSON.stringify(bad));
    }
  });

  it("rejects error codes that are not plain lowercase words", () => {
    for (const error of ["Not Allowed", "<img src=x>", "a/b", "x".repeat(65), ""]) {
      assert.equal(parseVoiceEvent({ type: "error", error }), null, error);
    }
  });

  it("caps transcript length so a bad sender cannot flood the bar", () => {
    const parsed = parseVoiceEvent({ type: "interim", text: "a".repeat(9000) });
    assert.equal(parsed?.type === "interim" ? parsed.text.length : -1, 4000);
  });

  it("drops extra fields rather than forwarding them", () => {
    assert.deepEqual(parseVoiceEvent({ type: "final", text: "ok", extra: "x" }), { type: "final", text: "ok" });
  });
});

describe("voice text helpers", () => {
  it("joins spoken text after typed text with one space", () => {
    assert.equal(joinVoiceText("make the", "  text bigger "), "make the text bigger");
    assert.equal(joinVoiceText("typed   ", "spoken"), "typed spoken");
  });

  it("keeps typed text when nothing was heard and speaks into an empty box", () => {
    assert.equal(joinVoiceText("keep me  ", "   "), "keep me");
    assert.equal(joinVoiceText("", "hello"), "hello");
    assert.equal(joinVoiceText("", ""), "");
  });

  it("maps error codes to user-facing text", () => {
    assert.match(voiceErrorText("not-allowed"), /Microphone access is blocked/);
    assert.match(voiceErrorText("no-speech"), /Didn't hear anything/);
    assert.match(voiceErrorText("weird-code"), /weird-code/);
    assert.equal(voiceErrorText("aborted"), "Voice input stopped.");
  });

  it("describes each phase for the live region", () => {
    assert.equal(voiceStatusText(VOICE_IDLE), "Stopped");
    assert.equal(voiceStatusText(at("starting")), "Starting the microphone");
    assert.equal(voiceStatusText(at("listening")), "Listening");
    assert.equal(voiceStatusText(at("stopping")), "Stopping");
    assert.match(voiceStatusText(at("error", "network")), /could not be reached/);
  });

  it("never uses em dashes in user-facing text", () => {
    const messages = ["not-allowed", "service-not-allowed", "no-speech", "audio-capture", "network", "language-not-supported", "unsupported", "aborted", "other"].map(voiceErrorText);
    for (const text of messages) assert.equal(text.includes(String.fromCodePoint(0x2014)), false, text);
  });
});
