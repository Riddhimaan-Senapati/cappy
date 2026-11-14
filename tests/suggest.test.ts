import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageOutline } from "../shared/adaptation.js";
import type { SuggestMessage } from "../shared/protocol.js";
import { buildSuggestUser, parseSuggestion } from "../server/agent/suggest.js";

const page = { url: "https://shop.example/item", title: "Item", headings: [], elements: [], textSample: "", stats: {}, styleHints: {} } as unknown as PageOutline;

function message(patch: Partial<SuggestMessage> = {}): SuggestMessage {
  return { type: "suggest", requestId: "r", profile: [], applied: [], page, ...patch };
}

describe("parseSuggestion", () => {
  it("treats NONE in any casing or punctuation as no suggestion", () => {
    for (const raw of ["NONE", "none", "  None.  ", "\nnone!\n"]) assert.equal(parseSuggestion(raw), null);
  });

  it("reads the first JSON object even with prose around it", () => {
    const raw = 'Sure, here you go: {"text": "make text bigger", "reason": "You zoomed in 3 times", "scope": "site", "memory": "Prefers larger text"} Hope it helps.';
    assert.deepEqual(parseSuggestion(raw), {
      text: "make text bigger",
      reason: "You zoomed in 3 times",
      scope: "site",
      memory: "Prefers larger text",
    });
  });

  it("returns null for invalid JSON or no object", () => {
    assert.equal(parseSuggestion('{"text": "dim this page",}'), null);
    assert.equal(parseSuggestion("dim this page"), null);
    assert.equal(parseSuggestion(""), null);
  });

  it("fills defaults for missing optional fields", () => {
    assert.deepEqual(parseSuggestion('{"text": "dim this page"}'), { text: "dim this page", reason: "", scope: "site", memory: null });
  });

  it("strips surrounding quotes and whitespace from text", () => {
    assert.equal(parseSuggestion('{"text": "  \\"dim this page\\"  "}')?.text, "dim this page");
  });

  it("rejects overlong or empty text", () => {
    assert.equal(parseSuggestion(JSON.stringify({ text: "x".repeat(81) })), null);
    assert.equal(parseSuggestion(JSON.stringify({ text: "   " })), null);
    assert.equal(parseSuggestion(JSON.stringify({ text: "x".repeat(80) }))?.text.length, 80);
  });

  it("rejects an unknown scope and an overlong reason", () => {
    assert.equal(parseSuggestion(JSON.stringify({ text: "dim", scope: "page" })), null);
    assert.equal(parseSuggestion(JSON.stringify({ text: "dim", reason: "r".repeat(121) })), null);
  });
});

describe("buildSuggestUser", () => {
  it("describes noticed friction with counts", () => {
    const user = buildSuggestUser(message({
      friction: [
        { kind: "zoom-in", here: 3, elsewhere: 2, sites: 2, hourHere: 5, sessionHere: 9, sessionElsewhere: 14, sessionSites: 4, totalHere: 31 },
        { kind: "rage-click", here: 1, elsewhere: 0, sites: 1, hourHere: 1, sessionHere: 1, sessionElsewhere: 0, sessionSites: 1, totalHere: 1 },
      ],
    }));
    assert.match(user, /<noticed_friction>\n- zoom-in: here 3 \(10m\) · 5 \(1h\) · 9 \(6h\) · 31 all-time; other sites 14 \(6h\) across 3\n- rage-click: here 1 \(10m\) · 1 \(1h\) · 1 \(6h\) · 1 all-time\n<\/noticed_friction>/);
  });

  it("lists past suggestions with their outcomes, newest first, capped at 12", () => {
    const feedback = Array.from({ length: 14 }, (_, i) => ({ text: `ask ${i}`, host: "shop.example", outcome: "dismissed" as const, at: i }));
    const user = buildSuggestUser(message({ feedback: [...feedback, { text: "dim this page", host: "news.example", outcome: "undone", at: 100 }] }));
    assert.match(user, /- "dim this page" on news\.example: undone\n/);
    assert.match(user, /- "ask 13" on shop\.example: dismissed/);
    assert.doesNotMatch(user, /"ask 1"/);
    assert.equal(user.match(/^- "/gm)?.length, 12);
  });

  it("says (none) when there is no friction or feedback", () => {
    const user = buildSuggestUser(message());
    assert.match(user, /<noticed_friction>\n\(none\)\n<\/noticed_friction>/);
    assert.match(user, /<past_suggestions>\n\(none\)\n<\/past_suggestions>/);
  });

  it("keeps the page outline in its untrusted block", () => {
    assert.match(buildSuggestUser(message()), /<untrusted_page_outline>\n\{"url":"https:\/\/shop\.example\/item"/);
  });
});
