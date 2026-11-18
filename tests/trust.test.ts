import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const A = `chrome-extension://${"a".repeat(32)}`;
const B = `chrome-extension://${"b".repeat(32)}`;

test("the first extension is pinned and a second one is refused", async () => {
  const pin = path.join(mkdtempSync(path.join(tmpdir(), "cappy-pin-")), "pin.json");
  process.env.CAPPY_PIN_PATH = pin;
  delete process.env.CAPPY_EXTENSION_IDS;
  delete process.env.CAPPY_TRUST_ANY_EXTENSION;
  const { allowRequest } = await import("../server/trust.js");
  assert.equal(allowRequest(A, "localhost:8787"), true);
  assert.deepEqual(JSON.parse(readFileSync(pin, "utf8")).origins, [A]);
  assert.equal(allowRequest(A, "127.0.0.1:8787"), true);
  assert.equal(allowRequest(B, "localhost:8787"), false);
});

test("web origins and rebinding hosts are refused", async () => {
  process.env.CAPPY_PIN_PATH = path.join(mkdtempSync(path.join(tmpdir(), "cappy-pin-")), "pin.json");
  const { allowRequest } = await import("../server/trust.js");
  assert.equal(allowRequest("https://evil.example", "localhost:8787"), false);
  assert.equal(allowRequest(undefined, "localhost:8787"), false);
  assert.equal(allowRequest(A, "evil.example:8787"), false);
});
