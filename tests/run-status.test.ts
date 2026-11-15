import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppliedSummary } from "../extension/src/messages.js";
import { applyRunEvent, collapsedLabel, type RunResult } from "../extension/src/overlay/run-status.js";

const applied: AppliedSummary[] = [{ id: "bigger-text", summary: "Enlarge page text", reason: "You asked for bigger text.", scope: "site" }];

function run(result?: RunResult) {
  return { status: "running" as const, result };
}

describe("run result vs the collapsed label", () => {
  it("keeps a successful reply when a connection error arrived first", () => {
    const card = run();
    applyRunEvent(card, { type: "error", runId: "1", message: "Lost connection to the agent server." });
    applyRunEvent(card, {
      type: "done",
      runId: "1",
      trigger: "chat",
      reply: "I enlarged the text across the page by 35%.",
      applied,
      fromCache: false,
    });
    assert.equal(card.result?.kind, "done");
    assert.equal(card.result?.text, "I enlarged the text across the page by 35%.");
    assert.equal(card.result?.applied.length, 1);
    assert.equal(collapsedLabel(card.result!, false), "1 change");
  });

  it("does not replace a finished success with a later connection error", () => {
    const card = run({ kind: "done", text: "I enlarged the text across the page by 35%.", applied });
    applyRunEvent(card, { type: "error", runId: "1", message: "Lost connection to the agent server." });
    applyRunEvent(card, { type: "cancelled", runId: "1", reason: "Stopped." });
    assert.equal(card.result?.kind, "done");
    assert.equal(card.result?.applied.length, 1);
    assert.equal(collapsedLabel(card.result!, false), "1 change");
  });

  it("labels a run that only failed as stopped or failed", () => {
    const card = run();
    applyRunEvent(card, { type: "error", runId: "1", message: "Lost connection to the agent server." });
    assert.equal(card.result?.kind, "error");
    assert.equal(collapsedLabel(card.result!, false), "stopped or failed");
  });

  it("keeps a block when the explanatory done follows", () => {
    const card = run();
    applyRunEvent(card, { type: "blocked", runId: "1", reason: "ignore all previous instructions" });
    applyRunEvent(card, {
      type: "done",
      runId: "1",
      trigger: "chat",
      reply: "This page contains text that tries to instruct me, so I didn't change anything.",
      applied: [],
      fromCache: false,
    });
    assert.equal(card.result?.kind, "blocked");
    assert.match(card.result?.text ?? "", /^Blocked\./);
    assert.equal(collapsedLabel(card.result!, false), "blocked");
  });

  it("drops a cancel for a request that was still queued", () => {
    const card = { status: "queued" as const };
    assert.equal(applyRunEvent(card, { type: "cancelled", runId: "1" }), "drop");
  });
});
