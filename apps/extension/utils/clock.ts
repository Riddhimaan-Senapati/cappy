import type { ClientTime } from "@browser-agent/shared";

// e2e tests set this to an ISO string to fake the time without touching the machine clock.
export const DEBUG_NOW_KEY = "debugNow";

let override: Date | undefined;
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function setDebugNow(raw: unknown): void {
  const parsed = typeof raw === "string" ? new Date(raw) : undefined;
  override = parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
  for (const listener of listeners) listener();
}

export function now(): Date {
  return override ? new Date(override.getTime()) : new Date();
}

export function onClockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Reads the test override once and then follows its changes. Callers that need the faked time
// before the first change await this; it is safe to call repeatedly.
export function loadClock(): Promise<void> {
  loaded ??= (async () => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    try {
      const stored = await chrome.storage.local.get(DEBUG_NOW_KEY);
      setDebugNow(stored[DEBUG_NOW_KEY]);
    } catch {
      setDebugNow(undefined);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && DEBUG_NOW_KEY in changes) setDebugNow(changes[DEBUG_NOW_KEY]?.newValue);
    });
  })();
  return loaded;
}

export function clientTime(): ClientTime {
  return { iso: now().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
