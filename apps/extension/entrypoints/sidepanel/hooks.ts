import { useEffect, useState } from "react";
import { DEFAULT_BACKEND_URL } from "@browser-agent/shared";
import { LastResult } from "../../utils/state";

export function useStored<T>(
  area: "local" | "session",
  key: string,
  parse: (raw: unknown) => T | undefined,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const stored = await chrome.storage[area].get(key);
      const next = parse(stored[key]);
      if (alive) setValue(next);
    };
    void load();
    const onChanged = (changes: Record<string, unknown>, changedArea: string) => {
      if (changedArea === area && key in changes) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [area, key, parse]);
  return value;
}

export const parseFlag = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);

export const parseLast = (raw: unknown): LastResult | undefined => {
  const parsed = LastResult.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type ServerHealth = "checking" | "online" | "offline";

const HEALTH_INTERVAL_MS = 10_000;

export function useServerHealth(): ServerHealth {
  const [health, setHealth] = useState<ServerHealth>("checking");
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ok = await fetch(`${DEFAULT_BACKEND_URL}/health`, { signal: AbortSignal.timeout(4_000) }).then(
        (res) => res.ok,
        () => false,
      );
      if (alive) setHealth(ok ? "online" : "offline");
    };
    void check();
    const timer = setInterval(() => void check(), HEALTH_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return health;
}
