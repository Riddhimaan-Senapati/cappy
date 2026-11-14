import { existsSync } from "node:fs";
import { CREDENTIALS_PATH } from "../../auth/chatgpt.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createStubProvider } from "./stub.js";
import { createChatGptProvider, createOpenAIKeyProvider } from "./openai.js";
import type { AgentProvider } from "./types.js";

const providers: Record<string, { ready: () => string | null; create: () => AgentProvider }> = {
  gemini: { ready: () => (process.env.GEMINI_API_KEY ? null : "needs GEMINI_API_KEY in .env"), create: createGeminiProvider },
  "anthropic-key": { ready: () => (process.env.ANTHROPIC_API_KEY ? null : "needs ANTHROPIC_API_KEY in .env"), create: createAnthropicProvider },
  "openai-key": { ready: () => (process.env.OPENAI_API_KEY ? null : "needs OPENAI_API_KEY in .env"), create: createOpenAIKeyProvider },
  stub: { ready: () => null, create: createStubProvider },
  "chatgpt-signin": { ready: () => (existsSync(CREDENTIALS_PATH) ? null : "needs a ChatGPT sign-in: run npm run chatgpt:login"), create: createChatGptProvider },
};

export function createProvider(): AgentProvider {
  const id = process.env.LLM_PROVIDER ?? "gemini";
  const entry = providers[id];
  if (!entry) throw new Error(`Unknown LLM_PROVIDER "${id}". Available: ${Object.keys(providers).join(", ")}`);
  const problem = entry.ready();
  if (problem) throw new Error(`LLM_PROVIDER=${id} ${problem}`);
  return entry.create();
}
