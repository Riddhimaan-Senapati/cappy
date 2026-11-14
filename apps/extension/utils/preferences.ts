import {
  BlockConfig,
  ContentFilter,
  GlobalChange,
  type Need,
  type Profile,
} from "@browser-agent/shared";
import { z } from "zod";

export const PREFERENCE_KEY = "preferenceChanges";

export const PreferenceStatus = z.enum(["compiled", "none", "error", "pending"]);
export type PreferenceStatus = z.infer<typeof PreferenceStatus>;

export const PreferenceEntry = z
  .object({
    detail: z.string().min(1).max(200),
    status: PreferenceStatus,
    change: GlobalChange.optional(),
    summary: z.string().max(160).optional(),
    reason: z.string().max(200).optional(),
    compiledAt: z.number().int().nonnegative(),
  })
  .strict();
export type PreferenceEntry = z.infer<typeof PreferenceEntry>;

export type PreferenceStore = Record<string, PreferenceEntry>;

// The merged form of every compiled preference, applied to a page as one layer.
export const PreferenceLayer = z
  .object({
    css: z.string().max(60_000).optional(),
    blocks: z.array(BlockConfig).max(30),
    filters: z.array(ContentFilter).max(30),
  })
  .strict();
export type PreferenceLayer = z.infer<typeof PreferenceLayer>;

export const EMPTY_LAYER: PreferenceLayer = { blocks: [], filters: [] };

export function parseStore(raw: unknown): PreferenceStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const store: PreferenceStore = {};
  for (const [id, value] of Object.entries(raw)) {
    const parsed = PreferenceEntry.safeParse(value);
    if (parsed.success) store[id] = parsed.data;
  }
  return store;
}

function preferenceNeeds(profile: Profile): Need[] {
  return profile.needs.filter((n) => n.kind === "preference");
}

// A preference is final once compiled or judged to need no change; errors and in-flight work are retried.
export function diffPreferences(
  profile: Profile,
  store: PreferenceStore,
): { toCompile: Need[]; toRemove: string[] } {
  const needs = preferenceNeeds(profile);
  const live = new Set<string>(needs.map((n) => n.id));
  const toCompile = needs.filter((need) => {
    const entry = store[need.id];
    if (!entry || entry.detail !== need.detail) return true;
    return entry.status !== "compiled" && entry.status !== "none";
  });
  const toRemove = Object.keys(store).filter((id) => !live.has(id));
  return { toCompile, toRemove };
}

// Compiled preferences are enforced by their layer, so the model does not need to see them.
export function withoutCompiledPreferences(profile: Profile, store: PreferenceStore): Profile {
  const needs = profile.needs.filter((need) => {
    const entry = store[need.id];
    return !(need.kind === "preference" && entry?.status === "compiled" && entry.detail === need.detail);
  });
  return { ...profile, needs };
}

export function mergeChanges(store: PreferenceStore): PreferenceLayer {
  const css: string[] = [];
  const blocks: PreferenceLayer["blocks"] = [];
  const seen = new Set<string>();
  const filters: PreferenceLayer["filters"] = [];
  for (const entry of Object.values(store)) {
    if (entry.status !== "compiled" || !entry.change) continue;
    if (entry.change.css) css.push(entry.change.css);
    for (const block of entry.change.blocks) {
      if (seen.has(block.block)) continue;
      seen.add(block.block);
      blocks.push(block);
    }
    filters.push(...entry.change.filters);
  }
  return css.length > 0 ? { css: css.join("\n"), blocks, filters } : { blocks, filters };
}

export function layerIsEmpty(layer: PreferenceLayer): boolean {
  return !layer.css && layer.blocks.length === 0 && layer.filters.length === 0;
}

export async function readPreferenceStore(): Promise<PreferenceStore> {
  try {
    const stored = await chrome.storage.local.get(PREFERENCE_KEY);
    return parseStore(stored[PREFERENCE_KEY]);
  } catch {
    return {};
  }
}

// Store writes are queued so that overlapping compiles cannot overwrite each other's results.
let storeQueue: Promise<unknown> = Promise.resolve();

export function updatePreferenceStore(mutate: (store: PreferenceStore) => void): Promise<void> {
  const next = storeQueue.then(async () => {
    const store = await readPreferenceStore();
    mutate(store);
    await chrome.storage.local.set({ [PREFERENCE_KEY]: store });
  });
  storeQueue = next.catch(() => undefined);
  return next;
}
