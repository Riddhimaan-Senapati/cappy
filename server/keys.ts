import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type KeyName =
  | "GEMINI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY"
  | "OPENAI_AUDIO_API_KEY"
  | "GEMINI_AUDIO_API_KEY"
  | "XAI_API_KEY"
  | "OPENAI_COMPAT_API_KEY"
  | "OPENAI_COMPAT_BASE_URL"
  | "ANTHROPIC_COMPAT_API_KEY"
  | "ANTHROPIC_COMPAT_BASE_URL";

export function normalizeBaseURL(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.toString().replace(/\/$/, "");
}

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEYS_PATH = path.join(rootDir, ".agent-keys.json");

function readStore(): Partial<Record<KeyName, string>> {
  try {
    return JSON.parse(readFileSync(KEYS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function getKey(name: KeyName): string | undefined {
  return readStore()[name] || process.env[name] || undefined;
}

export function setKey(name: KeyName, value: string | null) {
  const next = { ...readStore() };
  if (value) next[name] = value;
  else delete next[name];
  const temp = `${KEYS_PATH}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temp, KEYS_PATH);
}
