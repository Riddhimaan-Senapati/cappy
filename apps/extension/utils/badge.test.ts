import { expect, test } from "bun:test";
import { Profile } from "@browser-agent/shared";
import { reasonBadge } from "./badge";

const profile = Profile.parse({
  version: 2,
  summary: "",
  needs: [{ id: "n1", kind: "text_size", detail: "prefers larger text", source: "onboarding" }],
});

test("appends the need detail the reason was based on", () => {
  expect(reasonBadge("Larger text for reading", "n1", profile)).toBe(
    "Larger text for reading (because: prefers larger text)",
  );
});

test("leaves the reason alone when the need is unknown", () => {
  expect(reasonBadge("Larger text for reading", "missing", profile)).toBe("Larger text for reading");
});

test("keeps the badged reason within the banner limit", () => {
  const long = Profile.parse({
    version: 1,
    summary: "",
    needs: [{ id: "n1", kind: "text_size", detail: "x".repeat(200), source: "onboarding" }],
  });
  expect(reasonBadge("r".repeat(160), "n1", long).length).toBeLessThanOrEqual(200);
});
