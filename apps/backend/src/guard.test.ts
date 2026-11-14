import { describe, expect, test } from "bun:test";
import { Adaptation, AdaptResponse } from "@browser-agent/shared";
import { BLOCKED_UNKNOWN_ELEMENTS, guardSnapshotTargets } from "./guard";

function withOps(ops: unknown[]): AdaptResponse {
  return AdaptResponse.parse({
    kind: "adaptation",
    adaptation: Adaptation.parse({
      id: "a1",
      sites: ["example.com"],
      reason: { text: "hide clutter", needId: "n1" },
      blocks: [],
      ops,
    }),
  });
}

const elements = [
  { id: "n1", tag: "aside", text: "Recommended" },
  { id: "n2", tag: "button", text: "Subscribe" },
];

describe("guardSnapshotTargets", () => {
  test("passes ops that name ids from the outline", () => {
    const response = withOps([{ op: "hide", ids: ["n1", "n2"] }]);
    expect(guardSnapshotTargets(response, elements)).toBe(response);
  });

  test("blocks ops that name an id the page did not have", () => {
    const response = withOps([{ op: "hide", ids: ["n1", "n99"] }]);
    expect(guardSnapshotTargets(response, elements)).toEqual(BLOCKED_UNKNOWN_ELEMENTS);
  });

  test("blocks style ops with unknown ids", () => {
    const response = withOps([{ op: "style", ids: ["n7"], styles: { color: "red" } }]);
    expect(guardSnapshotTargets(response, elements)).toEqual({
      kind: "blocked",
      reason: "adaptation targeted elements the page did not have",
    });
  });

  test("blocks ops when the outline sent no elements", () => {
    const response = withOps([{ op: "hide", ids: ["n1"] }]);
    expect(guardSnapshotTargets(response, undefined)).toEqual(BLOCKED_UNKNOWN_ELEMENTS);
  });

  test("adaptations without ops and non-adaptation answers pass through", () => {
    const css = AdaptResponse.parse({
      kind: "adaptation",
      adaptation: Adaptation.parse({
        id: "a2",
        sites: ["example.com"],
        reason: { text: "invert", needId: "n1" },
        blocks: [],
        css: "html { filter: invert(1); }",
      }),
    });
    expect(guardSnapshotTargets(css, undefined)).toBe(css);
    const none: AdaptResponse = { kind: "none", reason: "nothing" };
    expect(guardSnapshotTargets(none, undefined)).toBe(none);
  });
});
