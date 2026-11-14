import { expect, test } from "bun:test";
import { AdaptResponse } from "@browser-agent/shared";
import { parseAdaptText, responseJsonSchema } from "../gemini-adapter";
import { strictCompatible } from "./client";
import { unwrapResult } from "./providers";
import { stripNulls, toStrictSchema } from "./strict-schema";

test("adaptation schema becomes strict-compatible", () => {
  const strict = toStrictSchema({ type: "object", properties: { result: responseJsonSchema() }, required: ["result"] });
  expect(strictCompatible(strict)).toBe(true);
});

test("optional fields become nullable and nulls are stripped before validation", () => {
  const strict = toStrictSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] }) as any;
  expect(strict.required).toEqual(["a", "b"]);
  expect(strict.properties.b).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
  const answer = {
    kind: "adaptation",
    adaptation: {
      id: "x",
      sites: ["example.com"],
      reason: { text: "Larger text", needId: "n1" },
      blocks: [{ block: "text_focus", fontScale: 1.3, lineHeight: 1.6, font: "system", hide: [] }],
      css: null,
      ops: null,
    },
  };
  expect(AdaptResponse.safeParse(answer).success).toBe(false);
  expect(AdaptResponse.safeParse(stripNulls(answer)).success).toBe(true);
});

test("the strict adaptation schema keeps schedule and everywhere, and nulls from optional fields are removed", () => {
  const strict = toStrictSchema({ type: "object", properties: { result: responseJsonSchema() }, required: ["result"] });
  const text = JSON.stringify(strict);
  expect(text).toContain("schedule");
  expect(text).toContain("everywhere");
  const answer = JSON.stringify({
    result: {
      kind: "adaptation",
      adaptation: {
        id: "a1",
        sites: ["youtube.com"],
        reason: { text: "Hide podcasts on weekdays", needId: "n1" },
        blocks: [],
        filters: [
          {
            itemSelector: null,
            keywords: ["podcast"],
            action: "hide",
            schedule: { days: ["mon"], start: "09:00", end: "17:00", from: null, until: null },
            everywhere: null,
          },
        ],
      },
    },
  });
  const parsed = parseAdaptText(unwrapResult(answer));
  expect(parsed.kind).toBe("adaptation");
  expect(parsed.kind === "adaptation" && parsed.adaptation.filters?.[0]).toEqual({
    keywords: ["podcast"],
    action: "hide",
    schedule: { days: ["mon"], start: "09:00", end: "17:00" },
  });
});
