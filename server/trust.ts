import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinPath = () => process.env.CAPPY_PIN_PATH ?? path.join(rootDir, ".agent-extension.json");
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function pinned(): string[] {
  const fromEnv = (process.env.CAPPY_EXTENSION_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean).map((id) => `chrome-extension://${id}`);
  if (fromEnv.length) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(pinPath(), "utf8")) as { origins?: unknown };
    return Array.isArray(parsed.origins) ? parsed.origins.filter((origin): origin is string => typeof origin === "string" && ORIGIN.test(origin)) : [];
  } catch {
    return [];
  }
}

// The first extension to connect is pinned, so a later extension on this computer cannot use the keys or accounts held here. Cappy's own ID stays the same for an unpacked folder or a store install.
export function allowRequest(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !ORIGIN.test(origin) || !host || !LOCAL_HOST.test(host)) return false;
  if (process.env.CAPPY_TRUST_ANY_EXTENSION === "1") return true;
  const allowed = pinned();
  if (allowed.length) return allowed.includes(origin);
  writeFileSync(pinPath(), JSON.stringify({ origins: [origin] }, null, 2), { mode: 0o600 });
  console.log(`[trust] pinned ${origin} as the only extension allowed to use this server. Delete ${path.basename(pinPath())} or set CAPPY_EXTENSION_IDS to change it.`);
  return true;
}
