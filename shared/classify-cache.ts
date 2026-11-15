// Bump this when server/agent/classify.ts changes what a verdict means. Old rows are then ignored.
export const CLASSIFY_CACHE_VERSION = 1;
export const CLASSIFY_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// chrome.storage.local is 10 MB unless the manifest asks for unlimitedStorage.
// 12 sites, 4 descriptions, 60 texts stays near 1 MB so profile and saved changes can still be written.
export const CLASSIFY_CACHE_HOSTS = 12;
export const CLASSIFY_CACHE_MATCHES = 4;
export const CLASSIFY_CACHE_TEXTS = 60;
export const CLASSIFY_CACHE_LOAD_MS = 2_000;

export type ClassifyRows = Record<string, { verdict: boolean; at: number }>;
export type ClassifyHostCache = { version: number; matches: Record<string, ClassifyRows> };

export function classifyCacheKey(profileId: string, host: string): string {
  return `classifyCache:${profileId}:${host.toLowerCase()}`;
}

export function emptyClassifyHost(): ClassifyHostCache {
  return { version: CLASSIFY_CACHE_VERSION, matches: {} };
}

export function readClassifyHost(value: unknown): ClassifyHostCache | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { version?: unknown; matches?: unknown };
  if (record.version !== CLASSIFY_CACHE_VERSION || !record.matches || typeof record.matches !== "object") return null;
  return { version: CLASSIFY_CACHE_VERSION, matches: record.matches as ClassifyHostCache["matches"] };
}

function freshest(rows: ClassifyRows, now: number): ClassifyRows {
  const next: ClassifyRows = {};
  for (const [text, row] of Object.entries(rows)) {
    if (!row || typeof row.verdict !== "boolean" || typeof row.at !== "number") continue;
    if (now - row.at >= CLASSIFY_CACHE_TTL_MS) continue;
    delete next[text];
    next[text] = row;
  }
  const texts = Object.keys(next);
  for (const old of texts.slice(0, Math.max(0, texts.length - CLASSIFY_CACHE_TEXTS))) delete next[old];
  return next;
}

export function mergeClassifyHost(current: ClassifyHostCache | null, updates: Record<string, Record<string, boolean>>, now: number): ClassifyHostCache {
  const matches: ClassifyHostCache["matches"] = {};
  const kept = current?.version === CLASSIFY_CACHE_VERSION ? current.matches : {};
  for (const [match, rows] of Object.entries(kept)) {
    const fresh = freshest(rows, now);
    if (Object.keys(fresh).length) matches[match] = fresh;
  }
  for (const [match, rows] of Object.entries(updates)) {
    const next = { ...(matches[match] ?? {}) };
    for (const [text, verdict] of Object.entries(rows)) {
      if (typeof verdict !== "boolean" || !text) continue;
      delete next[text];
      next[text] = { verdict, at: now };
    }
    const fresh = freshest(next, now);
    if (Object.keys(fresh).length) matches[match] = fresh;
    else delete matches[match];
  }
  const names = Object.keys(matches);
  for (const old of names.slice(0, Math.max(0, names.length - CLASSIFY_CACHE_MATCHES))) delete matches[old];
  return { version: CLASSIFY_CACHE_VERSION, matches };
}
