import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CLASSIFY_CACHE_HOSTS, CLASSIFY_CACHE_TTL_MS, CLASSIFY_CACHE_VERSION, classifyCacheKey, mergeClassifyHost } from "../shared/classify-cache.js";
import { loadClassifyHost, saveClassifyVerdicts } from "../extension/src/storage.js";

const originalChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = originalChrome;
});

function storage() {
  const data: Record<string, unknown> = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((entry) => data[entry] !== undefined).map((entry) => [entry, data[entry]]));
        },
        set: async (patch: Record<string, unknown>) => {
          Object.assign(data, patch);
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        },
      },
    },
  } as unknown as typeof chrome;
  return data;
}

describe("classify cache limits", () => {
  it("merges a later tab's verdicts instead of replacing the site", async () => {
    storage();
    const now = 1_700_000_000_000;
    await saveClassifyVerdicts("default", "news.ycombinator.com", { shorts: { "one clip": true } }, now);
    await saveClassifyVerdicts("default", "news.ycombinator.com", { shorts: { "other clip": false } }, now + 1);
    const host = await loadClassifyHost("default", "news.ycombinator.com");
    assert.equal(host?.matches.shorts?.["one clip"]?.verdict, true);
    assert.equal(host?.matches.shorts?.["other clip"]?.verdict, false);
  });

  it("drops a different prompt version and rows older than two weeks", () => {
    const now = CLASSIFY_CACHE_TTL_MS + 50;
    const merged = mergeClassifyHost(
      { version: CLASSIFY_CACHE_VERSION, matches: { shorts: { stale: { verdict: true, at: 0 }, fresh: { verdict: false, at: now - 1 } } } },
      { shorts: { added: true } },
      now,
    );
    assert.equal(merged.matches.shorts?.stale, undefined);
    assert.equal(merged.matches.shorts?.fresh?.verdict, false);
    assert.equal(merged.matches.shorts?.added?.verdict, true);
    const staleFile = mergeClassifyHost({ version: CLASSIFY_CACHE_VERSION + 1, matches: { shorts: { old: { verdict: true, at: now } } } }, { shorts: { added: false } }, now);
    assert.equal(staleFile.matches.shorts?.old, undefined);
    assert.equal(staleFile.matches.shorts?.added?.verdict, false);
  });

  it("keeps only the newest sites so the cache stays inside the storage quota", async () => {
    const data = storage();
    for (let index = 0; index < CLASSIFY_CACHE_HOSTS + 1; index++) {
      await saveClassifyVerdicts("default", `site${index}.example`, { shorts: { title: true } }, 1_000 + index);
    }
    assert.equal(data[classifyCacheKey("default", "site0.example")], undefined);
    assert.ok(data[classifyCacheKey("default", `site${CLASSIFY_CACHE_HOSTS}.example`)]);
    assert.equal((data.classifyCacheIndex as unknown[]).length, CLASSIFY_CACHE_HOSTS);
  });
});
