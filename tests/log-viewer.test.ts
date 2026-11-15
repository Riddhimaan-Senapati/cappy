import { test } from "node:test";
import assert from "node:assert/strict";
import { conversation, describeLog } from "../server/log-viewer.js";

test("log viewer summarizes Gemini tool calls and the original user request", () => {
  const log = describeLog({
    request: { contents: [{ role: "user", parts: [{ text: "<page_outline>large context</page_outline><user_message>Use dark mode</user_message>" }] }] },
    response: { modelVersion: "gemini-example", candidates: [{ content: { parts: [{ functionCall: { name: "screenshot", args: {} } }] } }], usageMetadata: { promptTokenCount: 123 } },
  }, "2026-11-15T00-24-16.263Z-example--run-abcdef.yaml");
  assert.equal(log.prompt, "Use dark mode");
  assert.equal(log.group, "abcdef");
  assert.equal(log.kind, "tool");
  assert.deepEqual(log.tools, ["screenshot"]);
  assert.equal(log.inputTokens, 123);
  assert.equal(log.at, "2026-11-15T00:24:16.263Z");
});

test("log viewer handles OpenAI, Anthropic, tool results, and unavailable screenshots", () => {
  assert.deepEqual(conversation({ output: [{ type: "function_call", name: "inspect", arguments: '{"selector":"body"}' }] }), [{ kind: "tool", name: "inspect", input: '{"selector":"body"}' }]);
  assert.deepEqual(conversation({ content: [{ type: "tool_use", name: "read_page", input: {} }, { type: "text", text: "Done" }] }), [{ kind: "tool", name: "read_page", input: {} }, { kind: "text", text: "Done" }]);
  assert.deepEqual(conversation({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "inspect", arguments: "{}" } }] } }] }), [{ kind: "tool", name: "inspect", input: "{}" }]);
  assert.equal(conversation({ functionResponse: { name: "inspect", response: { output: "result" } } })[0].kind, "result");
  assert.equal(conversation({ inlineData: { mimeType: "image/jpeg", data: "{{data__size_87_860}}" } })[0].available, false);
  assert.equal(conversation({ type: "image", source: { data: "/api/llm-logs/images/example.jpg" } })[0].available, true);
  assert.equal(conversation({ type: "input_image", image_url: "https://external.example/image.png" })[0].available, false);
});
