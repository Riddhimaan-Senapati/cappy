import type { AppDeps } from "./app";
import { geminiAdapter } from "./gemini-adapter";
import { geminiLlm } from "./gemini-llm";
import { stubAdapter } from "./stub-adapter";
import { stubLlm } from "./stub-llm";

export type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = "gemini-flash-latest";
const DEFAULT_PORT = 8787;

export function depsFromEnv(env: Env): AppDeps {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return { adapter: stubAdapter, llm: stubLlm };
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  return { adapter: geminiAdapter(apiKey, model), llm: geminiLlm(apiKey, model) };
}

export function portFromEnv(env: Env): number {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}
