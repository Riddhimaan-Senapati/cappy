import assert from "node:assert/strict";
import test from "node:test";
import { parseClientMessage } from "../server/messages.js";

const run = { type: "run", runId: "r1", trigger: "chat", message: "make it bigger", routing: "auto", history: [], profile: [], active: [], page: { title: "t" } };

test("a well-formed run and the small messages pass", () => {
  assert.equal(parseClientMessage(JSON.stringify(run))?.type, "run");
  assert.equal(parseClientMessage('{"type":"ping"}')?.type, "ping");
  assert.equal(parseClientMessage('{"type":"toolResult","callId":"c","ok":true,"result":{"a":1}}')?.type, "toolResult");
  assert.equal(parseClientMessage('{"type":"setKey","provider":"openai","key":null}')?.type, "setKey");
  assert.equal(parseClientMessage('{"type":"classify","requestId":"q","match":"ads","items":["a","b"]}')?.type, "classify");
});

test("bad JSON, unknown types and wrong shapes are dropped", () => {
  for (const raw of ["not json", "null", "[]", '"run"', '{"type":"nope"}', '{"type":"constructor"}', '{"type":"__proto__"}', '{"type":"cancel"}', '{"type":"toolResult","callId":"c","ok":"yes"}']) {
    assert.equal(parseClientMessage(raw), null, raw);
  }
});

test("limits stop oversized and mistyped fields", () => {
  assert.equal(parseClientMessage(JSON.stringify({ ...run, message: "x".repeat(20_001) })), null);
  assert.equal(parseClientMessage(JSON.stringify({ ...run, trigger: "voice" })), null);
  assert.equal(parseClientMessage(JSON.stringify({ ...run, page: "string" })), null);
  assert.equal(parseClientMessage(JSON.stringify({ ...run, profile: [1] })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: "classify", requestId: "q", match: "m", items: Array(2001).fill("a") })), null);
});
