import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type KeyName = "GEMINI_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";

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
