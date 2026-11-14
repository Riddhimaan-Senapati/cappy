import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateChange, type ActiveChange, type PageOutline } from "../shared/adaptation.js";
import type { RunRequest } from "../shared/protocol.js";
import { appendRevision, changeScript, previousRevision, revisionsFor } from "../extension/src/storage.js";
import { SYSTEM_PROMPT, buildUserTurn } from "../server/agent/prompt.js";
import { planStubRun } from "../server/agent/providers/stub.js";
import { pickTier } from "../server/agent/router.js";

const page = (): PageOutline => ({
  url: "http://localhost:8787/demo/campus.html",
  title: "Campus",
  headings: [],
  elements: [],
  itemGroups: [{ selector: ".card", count: 2, samples: ["gaming video"] }],
  stats: { inputsWithoutLabel: 0, smallTargets: 0, smallText: 0, lowContrastText: 0, imagesWithoutAlt: 0, runningAnimations: 0, visibleAdsOrPopups: 0 },
  styleHints: { background: "#fff", color: "#000", fontSizePx: 16, fontFamily: "serif" },
  textSample: "",
});

function saved(patch: Partial<ActiveChange> = {}): ActiveChange {
  return {
    id: "hide-gaming-videos",
    summary: "Hiding videos about gaming",
    reason: "Request: hide videos about gaming",
    css: null,
    dom: null,
    block: { name: "contentFilter", keywords: ["gaming"], itemSelector: ".card", action: "hide" },
    scope: "site",
    schedule: null,
    appliedAt: 1,
    ...patch,
  };
}

const request = (patch: Partial<RunRequest>): RunRequest => ({
  type: "run",
  runId: "run",
  trigger: "chat",
  message: "hide videos about gaming",
  routing: "auto",
  history: [],
  profile: [],
  active: [],
  page: page(),
  ...patch,
});

describe("change history", () => {
  it("keeps the previous script when a change is rewritten", () => {
    const origin = "http://localhost:8787";
    const first = appendRevision([], origin, saved(), { source: "applied", note: "Saved" }, 10);
    const next = appendRevision(first, origin, saved({ summary: "Obscuring videos about gaming", block: { name: "contentFilter", keywords: ["gaming"], itemSelector: ".card", action: "dim" } }), { source: "improved", note: "Improved after a screenshot check" }, 20);
    assert.equal(next.length, 2);
    assert.equal(previousRevision(next, origin, saved())?.change.summary, "Hiding videos about gaming");
    assert.equal(changeScript(next[0].change) === changeScript(next[1].change), false);
  });

  it("does not record a page reload of the same script", () => {
    const origin = "http://localhost:8787";
    const first = appendRevision([], origin, saved(), { source: "applied", note: "Saved" }, 10);
    assert.equal(appendRevision(first, origin, saved({ appliedAt: 99 }), { source: "applied", note: "Saved" }, 30), first);
  });

  it("lists site and everywhere scripts for the open page", () => {
    const origin = "http://localhost:8787";
    const revisions = appendRevision([], origin, saved({ id: "dark", summary: "Dark mode", scope: "everywhere", block: { name: "darkMode", allowSiteControls: false } }), { source: "applied", note: "Saved" });
    assert.equal(revisionsFor(revisions, "https://example.com").length, 1);
    assert.equal(revisionsFor(revisions, origin).length, 1);
  });
});

describe("self-improve routing", () => {
  it("uses Pro for a review and for make it work", () => {
    assert.equal(pickTier(request({ trigger: "review" })), "frontier");
    assert.equal(pickTier(request({ makeItWork: true })), "frontier");
    assert.equal(pickTier(request({ trigger: "page_load", message: "" })), "fast");
    assert.equal(pickTier(request({ routing: "fast", makeItWork: true })), "fast");
  });

  it("sends the saved script and the make it work flag to the model", () => {
    assert.match(SYSTEM_PROMPT, /apply_change now/);
    const review = buildUserTurn(request({ trigger: "review", message: "Check the saved changes", active: [saved()] }));
    assert.match(review, /<trigger>review<\/trigger>/);
    assert.match(review, /css:|block:/);
    assert.match(review, /Hiding videos about gaming/);
    const chat = buildUserTurn(request({ makeItWork: true }));
    assert.match(chat, /<make_it_work>on<\/make_it_work>/);
  });

  it("rewrites a simple hide request when make it work is on", () => {
    const plan = planStubRun({ trigger: "chat", message: "hide videos about gaming", profile: [], page: page(), makeItWork: true });
    const changes = plan.calls.flatMap((call) => (call.name === "apply_change" ? [call.input.change] : []));
    assert.equal(changes.length, 2);
    assert.equal(changes[0].id, changes[1].id);
    assert.equal(changes[0].block && "action" in changes[0].block ? changes[0].block.action : "", "hide");
    assert.equal(changes[1].block && "action" in changes[1].block ? changes[1].block.action : "", "dim");
    assert.match(plan.reply, /Identified an improvement/);
    assert.match(plan.reply, /Improved the script/);
    for (const change of changes) assert.equal(validateChange(change), null);
  });

  it("leaves a working review alone and rewrites a broken script", () => {
    const quiet = planStubRun({ trigger: "review", message: "Check", profile: [], page: page(), active: [saved()] });
    assert.equal(quiet.calls.length, 0);
    const broken = saved({ id: "needs-fix", css: ".nope { color: red; }", block: null });
    const plan = planStubRun({ trigger: "review", message: "Check", profile: [], page: page(), active: [broken] });
    const [change] = plan.calls.flatMap((call) => (call.name === "apply_change" ? [call.input.change] : []));
    assert.equal(change?.id, "needs-fix");
    assert.match(change?.css ?? "", /blur/);
    assert.match(plan.reply, /Improved the script/);
    assert.equal(validateChange(change!), null);
  });
});
