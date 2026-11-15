import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { exportConfig, importConfig, parseConfig } from "../extension/src/config.js";
import { DEFAULTS } from "../extension/src/storage.js";
import { profileState } from "../extension/src/profiles.js";

const originalChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = originalChrome; });

function storage(initial: Record<string, unknown>) {
  const data = structuredClone(initial);
  globalThis.chrome = { storage: { local: {
    get: async () => data,
    set: async (patch: Record<string, unknown>) => { Object.assign(data, patch); },
  } } } as unknown as typeof chrome;
  return data;
}

test("config round trip preserves profiles and preferences while keeping device credentials local", async () => {
  storage({
    ...DEFAULTS,
    profile: ["Use larger text"],
    profiles: { default: { name: "Default" }, work: { name: "Work", state: profileState(DEFAULTS) } },
    voiceLang: "pt-BR",
    serverUrl: "ws://old-computer:8787/agent",
    voiceProvider: "openai",
    openAIVoiceVerified: true,
    apiKey: "private-key",
  });
  const exported = await exportConfig();
  assert.ok(!exported.includes("private-key"));
  assert.ok(!exported.includes("old-computer"));
  const parsed = parseConfig(exported);
  const target = storage({
    ...DEFAULTS, serverUrl: "ws://new-computer:8787/agent", apiKey: "local-key", usage: { calls: 5 },
  });
  await importConfig(parsed);
  assert.deepEqual(target.profile, ["Use larger text"]);
  assert.equal(target.voiceLang, "pt-BR");
  assert.deepEqual(target.profiles, parsed.profiles);
  assert.equal(target.serverUrl, "ws://new-computer:8787/agent");
  assert.equal(target.apiKey, "local-key");
  assert.deepEqual(target.usage, { calls: 5 });
  assert.equal(target.voiceProvider, "chrome");
  assert.equal(target.openAIVoiceVerified, false);
  assert.equal(typeof target.configImportedAt, "number");
});

test("invalid files, broken profiles, and unsafe saved changes are rejected", async () => {
  storage(DEFAULTS as unknown as Record<string, unknown>);
  const valid = JSON.parse(await exportConfig());
  for (const value of ["not json", "{}", JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, settings: { ...valid.settings, activeProfileId: "missing" } }),
    JSON.stringify({ ...valid, settings: { ...valid.settings, camera: null } }),
    JSON.stringify({ ...valid, settings: { ...valid.settings, profiles: { default: { name: "Default" }, broken: { name: "Broken" } } } }),
    JSON.stringify({ ...valid, settings: { ...valid.settings, globalChanges: [{
      id: "unsafe", summary: "Unsafe", reason: "Test", css: "body { background: url(https://example.com); }",
      dom: null, block: null, scope: "everywhere", appliedAt: 1,
    }] } }),
  ]) assert.throws(() => parseConfig(value), /Invalid config file/);
});

test("exports as Cappy and still imports files saved before the rename", async () => {
  storage(DEFAULTS as unknown as Record<string, unknown>);
  const exported = JSON.parse(await exportConfig());
  assert.equal(exported.format, "cappy-config");
  assert.doesNotThrow(() => parseConfig(JSON.stringify({ ...exported, format: "browser-agent-config" })));
  assert.throws(() => parseConfig(JSON.stringify({ ...exported, format: "something-else" })), /Invalid config file/);
});

test("import reports storage failures", async () => {
  storage(DEFAULTS as unknown as Record<string, unknown>);
  const parsed = parseConfig(await exportConfig());
  chrome.storage.local.set = async () => { throw new Error("Storage is full"); };
  await assert.rejects(importConfig(parsed), /Storage is full/);
});
