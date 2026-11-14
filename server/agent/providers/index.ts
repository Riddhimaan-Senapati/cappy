import { getKey, type KeyName } from "../../keys.js";
import { existsSync } from "node:fs";
import { CREDENTIALS_PATH } from "../../auth/chatgpt.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createStubProvider } from "./stub.js";
import { createChatGptProvider, createOpenAIKeyProvider } from "./openai.js";
import type { AgentProvider } from "./types.js";

const providers: Record<string, { ready: () => string | null; create: () => AgentProvider }> = {
  gemini: { ready: () => (getKey("GEMINI_API_KEY") ? null : "needs GEMINI_API_KEY in .env"), create: createGeminiProvider },
  "anthropic-key": { ready: () => (getKey("ANTHROPIC_API_KEY") ? null : "needs ANTHROPIC_API_KEY in .env"), create: createAnthropicProvider },
  "openai-key": { ready: () => (getKey("OPENAI_API_KEY") ? null : "needs OPENAI_API_KEY in .env"), create: createOpenAIKeyProvider },
  stub: { ready: () => null, create: createStubProvider },
  "chatgpt-signin": { ready: () => (existsSync(CREDENTIALS_PATH) ? null : "needs a ChatGPT sign-in: run npm run chatgpt:login"), create: createChatGptProvider },
};

export const providerKeys = new Map<string, KeyName>([
  ["gemini", "GEMINI_API_KEY"], ["anthropic-key", "ANTHROPIC_API_KEY"], ["openai-key", "OPENAI_API_KEY"],
]);

export function providerOptions() {
  return ["chatgpt-signin", ...providerKeys.keys()].map((id) => ({ id, ready: !providers[id].ready() }));
}

export function createProvider(id = process.env.LLM_PROVIDER ?? "gemini"): AgentProvider {
  const entry = providers[id];
  if (!Object.hasOwn(providers, id)) throw new Error(`Unknown LLM_PROVIDER "${id}". Available: ${Object.keys(providers).join(", ")}`);
  const problem = entry.ready();
  if (problem) throw new Error(`LLM_PROVIDER=${id} ${problem}`);
  return entry.create();
}
