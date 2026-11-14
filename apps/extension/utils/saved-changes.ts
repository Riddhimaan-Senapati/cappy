import { z } from "zod";
import { Adaptation, matchesHost, type Adaptation as AdaptationT } from "@browser-agent/shared";

export const SAVED_KEY = "savedChanges";
export const MAX_SAVED_HOSTS = 200;

export const SavedEntry = z
  .object({
    adaptation: Adaptation,
    profileVersion: z.number().int().nonnegative(),
    savedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SavedEntry = z.infer<typeof SavedEntry>;
export type SavedChanges = Record<string, SavedEntry>;

export function parseSaved(raw: unknown): SavedChanges {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: SavedChanges = {};
  for (const [host, value] of Object.entries(raw)) {
    const parsed = SavedEntry.safeParse(value);
    if (parsed.success) out[host] = parsed.data;
  }
  return out;
}

// Ops hold snapshot ids that only mean something on the page they were made for.
export function stripOps(adaptation: AdaptationT): AdaptationT {
  const copy: Partial<AdaptationT> = { ...adaptation };
  delete copy.ops;
  return copy as AdaptationT;
}

export function lookup(
  saved: SavedChanges,
  host: string,
  profileVersion: number,
): AdaptationT | undefined {
  const key = host.toLowerCase();
  const entry = saved[key];
  if (!entry || entry.profileVersion !== profileVersion) return undefined;
  const covers = entry.adaptation.sites.some((pattern) => matchesHost(pattern, key));
  return covers ? entry.adaptation : undefined;
}

export function remember(
  saved: SavedChanges,
  host: string,
  adaptation: AdaptationT,
  profileVersion: number,
  now: number = Date.now(),
): SavedChanges {
  const key = host.toLowerCase();
  const stripped = stripOps(adaptation);
  if (!Adaptation.safeParse(stripped).success) return forget(saved, key);

  const next: SavedChanges = { ...saved, [key]: { adaptation: stripped, profileVersion, savedAt: now } };
  const hosts = Object.keys(next);
  if (hosts.length <= MAX_SAVED_HOSTS) return next;

  const oldest = hosts.sort((a, b) => next[a]!.savedAt - next[b]!.savedAt).slice(0, hosts.length - MAX_SAVED_HOSTS);
  for (const h of oldest) delete next[h];
  return next;
}

export function forget(saved: SavedChanges, host: string): SavedChanges {
  const key = host.toLowerCase();
  if (!(key in saved)) return saved;
  const next = { ...saved };
  delete next[key];
  return next;
}

let queue: Promise<unknown> = Promise.resolve();

export async function readSaved(): Promise<SavedChanges> {
  const stored = await chrome.storage.local.get(SAVED_KEY);
  return parseSaved(stored[SAVED_KEY]);
}

// Serialized so two tabs finishing at once cannot overwrite each other's entries.
export function updateSaved(change: (saved: SavedChanges) => SavedChanges): Promise<void> {
  const run = queue.then(async () => {
    const next = change(await readSaved());
    await chrome.storage.local.set({ [SAVED_KEY]: next });
  });
  queue = run.catch(() => undefined);
  return run;
}
