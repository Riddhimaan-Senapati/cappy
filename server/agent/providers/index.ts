import type { ProviderInfo } from "../../../shared/protocol.js";
import { isSignedIn } from "../../auth/chatgpt.js";
import { getKey, type KeyName } from "../../keys.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createAnthropicCompatibleProvider, createOpenAICompatibleProvider, createXaiProvider, endpointDetail } from "./endpoint.js";
import { createGeminiProvider } from "./gemini.js";
import { createStubProvider } from "./stub.js";
import { createChatGptProvider, createOpenAIKeyProvider } from "./openai.js";
import type { AgentProvider } from "./types.js";

interface Entry {
  label: string;
  setup: ProviderInfo["setup"];
  key?: KeyName;
  baseKey?: KeyName;
  ready(): boolean;
  create(): AgentProvider;
}

const keyed = (label: string, key: KeyName, create: () => AgentProvider): Entry => ({ label, setup: "key", key, ready: () => !!getKey(key), create });

const endpoint = (label: string, key: KeyName, baseKey: KeyName, create: () => AgentProvider): Entry => ({
  label,
  setup: "endpoint",
  key,
  baseKey,
  ready: () => !!getKey(key) && !!getKey(baseKey),
  create,
});

// Order is the fallback preference when the user has not picked a provider.
const REGISTRY: Record<string, Entry> = {
  "chatgpt-signin": { label: "ChatGPT", setup: "signin", ready: isSignedIn, create: createChatGptProvider },
  "anthropic-key": keyed("Claude", "ANTHROPIC_API_KEY", createAnthropicProvider),
  "openai-key": keyed("OpenAI API", "OPENAI_API_KEY", createOpenAIKeyProvider),
  gemini: keyed("Gemini", "GEMINI_API_KEY", createGeminiProvider),
  xai: keyed("SpaceXAI", "XAI_API_KEY", createXaiProvider),
  "openai-compat": endpoint("OpenAI-compatible", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_BASE_URL", createOpenAICompatibleProvider),
  "anthropic-compat": endpoint("Anthropic-compatible", "ANTHROPIC_COMPAT_API_KEY", "ANTHROPIC_COMPAT_BASE_URL", createAnthropicCompatibleProvider),
};

// The deterministic stub is for offline runs and e2e tests, so it only exists when explicitly requested.
const STUB: Entry = { label: "Offline stub", setup: "key", ready: () => true, create: createStubProvider };
const registry = (): Record<string, Entry> => (process.env.LLM_PROVIDER === "stub" ? { ...REGISTRY, stub: STUB } : REGISTRY);

const instances = new Map<string, { provider: AgentProvider; fingerprint: string }>();
const modelCache = new Map<string, { at: number; list: string[] }>();
const MODEL_TTL_MS = 5 * 60_000;
// Model lists cost an API call, so only fetch them for providers the user has actually selected.
const wanted = new Set<string>();

export function wantModels(id: string) {
  wanted.add(id);
}

const fingerprint = (entry: Entry) => `${entry.key ? (getKey(entry.key) ?? "") : String(entry.ready())}\n${entry.baseKey ? (getKey(entry.baseKey) ?? "") : ""}`;

export function keyFor(id: string): KeyName | undefined {
  return registry()[id]?.key;
}

export function baseKeyFor(id: string): KeyName | undefined {
  return registry()[id]?.baseKey;
}

export function forget(id: string) {
  instances.delete(id);
  modelCache.delete(id);
}

export function getProvider(id: string): AgentProvider | null {
  const entry = registry()[id];
  if (!entry?.ready()) return null;
  const print = fingerprint(entry);
  const cached = instances.get(id);
  if (cached && cached.fingerprint === print) return cached.provider;
  const provider = entry.create();
  instances.set(id, { provider, fingerprint: print });
  modelCache.delete(id);
  return provider;
}

export function defaultProviderId(): string | null {
  const preferred = process.env.LLM_PROVIDER;
  if (preferred && registry()[preferred]?.ready()) return preferred;
  return Object.keys(registry()).find((id) => registry()[id].ready()) ?? null;
}

export function resolveProvider(requested?: string | null): AgentProvider | null {
  if (requested) return getProvider(requested);
  return defaultProviderId() ? getProvider(defaultProviderId()!) : null;
}

async function availableModels(id: string, provider: AgentProvider): Promise<string[]> {
  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.list;
  let list: string[] = [];
  try {
    const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 4000));
    list = [...new Set(await Promise.race([provider.listModels?.() ?? Promise.resolve([]), timeout]))].sort();
  } catch (error) {
    console.warn(`[models] ${id}:`, error instanceof Error ? error.message : error);
  }
  modelCache.set(id, { at: Date.now(), list });
  return list;
}

export async function describeProviders(): Promise<ProviderInfo[]> {
  return Promise.all(
    Object.entries(registry()).map(async ([id, entry]) => {
      const provider = getProvider(id);
      const detail = entry.baseKey ? endpointDetail(entry.baseKey) : undefined;
      if (!provider) return { id, label: entry.label, setup: entry.setup, ready: false, ...(detail ? { detail } : {}) };
      const available = wanted.has(id) ? await availableModels(id, provider) : undefined;
      return { id, label: entry.label, setup: entry.setup, ready: true, ...(detail ? { detail } : {}), models: provider.models, available };
    }),
  );
}
