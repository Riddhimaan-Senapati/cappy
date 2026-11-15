import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeBaseURL } from "../server/keys.js";

describe("normalizeBaseURL", () => {
  it("keeps an http or https URL and drops a trailing slash", () => {
    assert.equal(normalizeBaseURL("https://api.x.ai/v1/"), "https://api.x.ai/v1");
    assert.equal(normalizeBaseURL(" http://127.0.0.1:8080/v1 "), "http://127.0.0.1:8080/v1");
  });

  it("rejects anything that is not a plain base URL", () => {
    assert.equal(normalizeBaseURL(""), null);
    assert.equal(normalizeBaseURL("api.example.com/v1"), null);
    assert.equal(normalizeBaseURL("ftp://api.example.com/v1"), null);
    assert.equal(normalizeBaseURL("https://user:secret@api.example.com/v1"), null);
  });
});
