import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paintedStatusKey } from "../extension/src/status-key.js";
import type { StatusInfo } from "../extension/src/messages.js";

const base = (): StatusInfo => ({
  connected: true,
  busy: false,
  error: undefined,
  activeProvider: "openai",
  provider: "OpenAI",
  providers: [{ id: "openai", label: "OpenAI", ready: true, setup: "key" }],
  notice: undefined,
});

describe("painted status key", () => {
  it("ignores a repeat of the same connection flags", () => {
    assert.equal(paintedStatusKey(base()), paintedStatusKey({ ...base(), connected: true }));
  });

  it("changes when provider rows arrive while already connected", () => {
    const before = paintedStatusKey(base());
    const after = paintedStatusKey({
      ...base(),
      providers: [
        { id: "openai", label: "OpenAI", ready: true, setup: "key", models: { fast: "gpt-fast", frontier: "gpt-pro" } },
        { id: "gemini", label: "Gemini", ready: false, setup: "key" },
      ],
    });
    assert.notEqual(before, after);
  });

  it("changes when the active provider, notice, models, or error change", () => {
    const before = paintedStatusKey(base());
    assert.notEqual(before, paintedStatusKey({ ...base(), activeProvider: "gemini" }));
    assert.notEqual(before, paintedStatusKey({ ...base(), notice: { level: "info", text: "Signed in" } }));
    assert.notEqual(before, paintedStatusKey({ ...base(), models: { fast: "gpt-fast", frontier: "gpt-pro" } }));
    assert.notEqual(before, paintedStatusKey({ ...base(), error: "offline" }));
    assert.notEqual(before, paintedStatusKey({ ...base(), busy: true }));
    assert.notEqual(before, paintedStatusKey({ ...base(), connected: false }));
  });
});
