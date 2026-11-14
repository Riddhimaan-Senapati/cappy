import type { ThinkingLevel } from "@google/genai";
import type { AppDeps } from "./app";
import { geminiAdapter } from "./gemini-adapter";
import { geminiLlm } from "./gemini-llm";
import { stubAdapter } from "./stub-adapter";
import { stubLlm } from "./stub-llm";

export type Env = Record<string, string | undefined>;

export const DEFAULT_ADAPT_MODEL = "gemini-3.6-flash";
export const DEFAULT_CHAT_MODEL = "gemini-3.8-flash";
const THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"] as const;
const DEFAULT_PORT = 8787;

function thinkingFrom(value: string | undefined): ThinkingLevel {
  const v = value?.trim().toUpperCase();
  return ((THINKING_LEVELS as readonly string[]).includes(v ?? "") ? v : "LOW") as ThinkingLevel;
}

export function depsFromEnv(env: Env): AppDeps {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return { adapter: stubAdapter, llm: stubLlm };
  const adaptModel = env.GEMINI_ADAPT_MODEL?.trim() || DEFAULT_ADAPT_MODEL;
  const chatModel = env.GEMINI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
  return {
    adapter: geminiAdapter(apiKey, adaptModel, thinkingFrom(env.GEMINI_ADAPT_THINKING)),
    llm: geminiLlm(apiKey, chatModel, thinkingFrom(env.GEMINI_CHAT_THINKING)),
  };
}

export function portFromEnv(env: Env): number {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}
