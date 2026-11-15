import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProactiveClaims } from "../extension/src/background/proactive-claims.js";

describe("page-load claims", () => {
  it("keeps a running check when the tab moves, and drops one that never started", () => {
    const claims = new ProactiveClaims();
    assert.equal(claims.begin(1, "site-a"), true);
    claims.noteStart(1, "run-a");
    assert.equal(claims.begin(1, "site-b"), true);
    assert.equal(claims.holds("site-a"), true);
    assert.equal(claims.begin(2, "site-a"), false);
    claims.release(1, "site-b");
    assert.equal(claims.holds("site-b"), false);
    assert.equal(claims.holds("site-a"), true);
    assert.equal(claims.finish(1, "run-a"), "site-a");
    claims.drop("site-a");
    assert.equal(claims.holds("site-a"), false);

    assert.equal(claims.begin(1, "site-c"), true);
    assert.equal(claims.begin(1, "site-d"), true);
    assert.equal(claims.holds("site-c"), false);
  });

  it("ignores a chat error while a page-load check is still running", () => {
    const claims = new ProactiveClaims();
    assert.equal(claims.begin(1, "site-a"), true);
    claims.noteStart(1, "page-run");
    assert.equal(claims.finish(1, "chat-run"), null);
    assert.equal(claims.holds("site-a"), true);
    assert.equal(claims.begin(2, "site-a"), false);
    assert.equal(claims.finish(1, "page-run"), "site-a");
    claims.drop("site-a");
    assert.equal(claims.holds("site-a"), false);
    assert.equal(claims.begin(2, "site-a"), true);
  });

  it("credits a late start to the site that began it, not the site the tab has moved to", () => {
    const claims = new ProactiveClaims();
    assert.equal(claims.begin(1, "site-a"), true);
    assert.equal(claims.begin(1, "site-b"), true);
    assert.equal(claims.holds("site-a"), false);
    claims.noteStart(1, "run-a", "site-a");
    assert.equal(claims.holds("site-a"), true);
    assert.equal(claims.holds("site-b"), true);
    assert.equal(claims.finish(1, "run-a"), "site-a");
    assert.equal(claims.holds("site-b"), true);
    assert.equal(claims.begin(2, "site-b"), false);
  });
});
