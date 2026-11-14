import { describe, expect, test } from "bun:test";
import { depsFromEnv, portFromEnv } from "./config";
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

describe("portFromEnv", () => {
  test("defaults to 8787 when PORT is missing or invalid", () => {
    expect(portFromEnv({})).toBe(8787);
    expect(portFromEnv({ PORT: "abc" })).toBe(8787);
    expect(portFromEnv({ PORT: "9000" })).toBe(9000);
  });
});
