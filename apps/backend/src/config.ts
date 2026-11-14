import type { ThinkingLevel } from "@google/genai";
import type { AppDeps } from "./app";
import { geminiAdapter } from "./gemini-adapter";
import { geminiLlm } from "./gemini-llm";
import { geminiRequester, stubRequester } from "./requester";
import { stubAdapter } from "./stub-adapter";
import { stubLlm } from "./stub-llm";
import { geminiVerifier, stubVerifier } from "./verifier";
import { chatgptSignedIn } from "./chatgpt/auth";
import { chatgptAdapter, chatgptLlm, chatgptRequester, chatgptVerifier } from "./chatgpt/providers";

export type Env = Record<string, string | undefined>;

export const DEFAULT_ADAPT_MODEL = "gemini-3.6-flash";
export const DEFAULT_CHAT_MODEL = "gemini-3.8-flash";
export const DEFAULT_VERIFY_MODEL = "gemini-3.8-flash";
const THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"] as const;
const DEFAULT_PORT = 8787;

function thinkingFrom(value: string | undefined): ThinkingLevel {
  const v = value?.trim().toUpperCase();
  return ((THINKING_LEVELS as readonly string[]).includes(v ?? "") ? v : "LOW") as ThinkingLevel;
}

const STUB_DEPS: AppDeps = { adapter: stubAdapter, llm: stubLlm, requester: stubRequester, verifier: stubVerifier };
const CHATGPT_DEPS: AppDeps = {
  adapter: chatgptAdapter,
  llm: chatgptLlm,
  requester: chatgptRequester,
  verifier: chatgptVerifier,
};

export function depsFromEnv(env: Env, signedIn: () => boolean = () => chatgptSignedIn()): AppDeps {
  const provider = env.LLM_PROVIDER?.trim().toLowerCase();
  if (provider === "stub") return STUB_DEPS;
  if (provider === "chatgpt") {
    if (signedIn()) return CHATGPT_DEPS;
    console.log("LLM_PROVIDER=chatgpt but no ChatGPT credentials were found; run bun run chatgpt:login. Using stubs.");
    return STUB_DEPS;
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return STUB_DEPS;
  const adaptModel = env.GEMINI_ADAPT_MODEL?.trim() || DEFAULT_ADAPT_MODEL;
  const chatModel = env.GEMINI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
  const verifyModel = env.GEMINI_VERIFY_MODEL?.trim() || DEFAULT_VERIFY_MODEL;
  const adaptThinking = thinkingFrom(env.GEMINI_ADAPT_THINKING);
  return {
    adapter: geminiAdapter(apiKey, adaptModel, adaptThinking),
    llm: geminiLlm(apiKey, chatModel, thinkingFrom(env.GEMINI_CHAT_THINKING)),
    requester: geminiRequester(apiKey, adaptModel, adaptThinking),
    verifier: geminiVerifier(apiKey, verifyModel),
  };
}

export function portFromEnv(env: Env): number {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}
