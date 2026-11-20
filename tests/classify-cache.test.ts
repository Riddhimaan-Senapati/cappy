import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { CLASSIFY_CACHE_HOSTS, CLASSIFY_CACHE_TTL_MS, CLASSIFY_CACHE_VERSION, CLASSIFY_INDEX_KEY, classifyCacheKey, classifyTextHash, mergeClassifyHost, mergeClassifyIndex } from "../shared/classify-cache.js";
import { clearClassifyCaches, importClassifyCaches, loadClassifyHost, saveClassifyVerdicts } from "../extension/src/storage.js";
import { SYSTEM } from "../server/agent/classify.js";

const originalChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = originalChrome;
});

function storage() {
  const data: Record<string, unknown> = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key?: string | string[] | null) => {
          if (key == null) return { ...data };
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
    assert.equal((data[CLASSIFY_INDEX_KEY] as unknown[]).length, CLASSIFY_CACHE_HOSTS);
  });

  it("refuses cache keys that are not classify cache entries", async () => {
    const data = storage();
    data.profile = ["keep me"];
    data.siteChanges = { "https://example.com": [] };
    await importClassifyCaches({
      profile: { version: 1, matches: {} },
      siteChanges: { version: 1, matches: { shorts: {} } },
      [classifyCacheKey("default", "news.ycombinator.com")]: { version: CLASSIFY_CACHE_VERSION, matches: { shorts: { abcd: { verdict: true, at: 1 } } } },
    } as never);
    assert.deepEqual(data.profile, ["keep me"]);
    assert.ok(data[classifyCacheKey("default", "news.ycombinator.com")]);
    const index = data[CLASSIFY_INDEX_KEY] as Array<{ key: string }>;
    assert.deepEqual(index.map((entry) => entry.key), [classifyCacheKey("default", "news.ycombinator.com")]);
  });

  it("stores a hash of the title, not the title", () => {
    const title = "Rust in 100 seconds";
    const hash = classifyTextHash(title);
    assert.equal(hash.includes("Rust"), false);
    assert.equal(hash, classifyTextHash(`  ${title}  `));
  });

  it("keeps the other tab's site when the index changes before the write lands", async () => {
    const data: Record<string, unknown> = {};
    let reads = 0;
    const other = classifyCacheKey("default", "other.example");
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            if (keys.length === 1 && keys[0] === CLASSIFY_INDEX_KEY) {
              reads += 1;
              if (reads === 2) {
                data[CLASSIFY_INDEX_KEY] = [{ key: other, at: 1 }];
                return { [CLASSIFY_INDEX_KEY]: data[CLASSIFY_INDEX_KEY] };
              }
            }
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
    await saveClassifyVerdicts("default", "news.ycombinator.com", { shorts: { ab: true } }, 10);
    const keys = (data[CLASSIFY_INDEX_KEY] as Array<{ key: string }>).map((entry) => entry.key).sort();
    assert.deepEqual(keys, [other, classifyCacheKey("default", "news.ycombinator.com")].sort());
  });

  it("keeps a local site when another site is imported, and clear removes orphaned blobs", async () => {
    const data = storage();
    await saveClassifyVerdicts("default", "local.example", { shorts: { ab: true } }, 1);
    const localKey = classifyCacheKey("default", "local.example");
    const imported = classifyCacheKey("default", "imported.example");
    const orphan = classifyCacheKey("default", "orphan.example");
    await importClassifyCaches({
      [imported]: { version: CLASSIFY_CACHE_VERSION, matches: { shorts: { cd: { verdict: true, at: 2 } } } },
    });
    data[orphan] = { version: CLASSIFY_CACHE_VERSION, matches: {} };
    const index = (data[CLASSIFY_INDEX_KEY] as Array<{ key: string }>).map((entry) => entry.key).sort();
    assert.deepEqual(index, [imported, localKey].sort());
    await clearClassifyCaches();
    assert.equal(data[localKey], undefined);
    assert.equal(data[imported], undefined);
    assert.equal(data[orphan], undefined);
    assert.deepEqual(data[CLASSIFY_INDEX_KEY], []);
  });

  it("keeps both sites when two index updates start from the same list", () => {
    const hostA = classifyCacheKey("default", "a.example");
    const hostB = classifyCacheKey("default", "b.example");
    const first = mergeClassifyIndex([], hostA, 1);
    const second = mergeClassifyIndex([], hostB, 2);
    const merged = mergeClassifyIndex(mergeClassifyIndex(first.index, hostB, 2).index, hostA, 1);
    assert.deepEqual(merged.index.map((entry) => entry.key).sort(), [hostA, hostB].sort());
    assert.deepEqual(second.index.map((entry) => entry.key), [hostB]);
  });
});

const RECORDED_CLASSIFY_PROMPT = { version: 3, hash: "62f62d82e3226c36c7dac31af5ac2e12c5812cb139cef4e81ba4f5b6c39619ba" };

describe("classify prompt", () => {
  it("records the prompt hash with the cache version", () => {
    const hash = createHash("sha256").update(SYSTEM).digest("hex");
    assert.equal(
      `${CLASSIFY_CACHE_VERSION}:${hash}`,
      `${RECORDED_CLASSIFY_PROMPT.version}:${RECORDED_CLASSIFY_PROMPT.hash}`,
      "The classify prompt changed. Bump CLASSIFY_CACHE_VERSION and update the recorded hash.",
    );
  });
});
