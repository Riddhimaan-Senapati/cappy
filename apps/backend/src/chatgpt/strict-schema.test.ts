import { expect, test } from "bun:test";
import { AdaptResponse } from "@browser-agent/shared";
import { responseJsonSchema } from "../gemini-adapter";
import { strictCompatible } from "./client";
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
