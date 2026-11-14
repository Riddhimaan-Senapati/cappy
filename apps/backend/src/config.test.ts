import { describe, expect, spyOn, test } from "bun:test";
import { depsFromEnv, portFromEnv } from "./config";
import { chatgptAdapter, chatgptLlm, chatgptRequester, chatgptVerifier } from "./chatgpt/providers";
import { stubAdapter } from "./stub-adapter";
import { stubLlm } from "./stub-llm";
import { stubRequester } from "./requester";
import { stubVerifier } from "./verifier";

describe("depsFromEnv", () => {
  test("uses stubs without a Gemini key", () => {
    const deps = depsFromEnv({ GEMINI_API_KEY: "" });
    expect(deps.adapter).toBe(stubAdapter);
    expect(deps.llm).toBe(stubLlm);
    expect(deps.requester).toBe(stubRequester);
    expect(deps.verifier).toBe(stubVerifier);
  });

  test("selects Gemini clients when a key is set", () => {
    const deps = depsFromEnv({ GEMINI_API_KEY: "test-key" });
    expect(deps.adapter).not.toBe(stubAdapter);
    expect(deps.llm).not.toBe(stubLlm);
    expect(deps.requester).not.toBe(stubRequester);
    expect(deps.verifier).not.toBe(stubVerifier);
  });
});

describe("depsFromEnv LLM_PROVIDER", () => {
  test("chatgpt with credentials selects the ChatGPT providers", () => {
    const deps = depsFromEnv({ LLM_PROVIDER: "chatgpt" }, () => true);
    expect(deps.adapter).toBe(chatgptAdapter);
    expect(deps.llm).toBe(chatgptLlm);
    expect(deps.requester).toBe(chatgptRequester);
    expect(deps.verifier).toBe(chatgptVerifier);
  });

  test("chatgpt without credentials logs the login hint once and falls back to stubs", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const deps = depsFromEnv({ LLM_PROVIDER: "chatgpt", GEMINI_API_KEY: "test-key" }, () => false);
      expect(deps.adapter).toBe(stubAdapter);
      expect(deps.llm).toBe(stubLlm);
      expect(deps.requester).toBe(stubRequester);
      expect(deps.verifier).toBe(stubVerifier);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toContain("bun run chatgpt:login");
    } finally {
      log.mockRestore();
    }
  });

  test("stub forces stubs even with a Gemini key", () => {
    const deps = depsFromEnv({ LLM_PROVIDER: "stub", GEMINI_API_KEY: "test-key" });
    expect(deps.llm).toBe(stubLlm);
    expect(deps.adapter).toBe(stubAdapter);
  });

  test("gemini and unset both keep the Gemini path", () => {
    expect(depsFromEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" }).llm).not.toBe(stubLlm);
    expect(depsFromEnv({ LLM_PROVIDER: undefined, GEMINI_API_KEY: "test-key" }).llm).not.toBe(stubLlm);
  });
});

describe("portFromEnv", () => {
  test("defaults to 8787 when PORT is missing or invalid", () => {
    expect(portFromEnv({})).toBe(8787);
    expect(portFromEnv({ PORT: "abc" })).toBe(8787);
    expect(portFromEnv({ PORT: "9000" })).toBe(9000);
  });
});
