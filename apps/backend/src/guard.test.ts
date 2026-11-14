import { describe, expect, test } from "bun:test";
import { Adaptation, AdaptResponse } from "@browser-agent/shared";
import { BLOCKED_UNKNOWN_ELEMENTS, BLOCKED_UNKNOWN_GROUPS, guardContentGroups, guardSnapshotTargets } from "./guard";

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

function withFilters(filters: unknown[]): AdaptResponse {
  return AdaptResponse.parse({
    kind: "adaptation",
    adaptation: Adaptation.parse({
      id: "a3",
      sites: ["youtube.com"],
      reason: { text: "remove podcasts", needId: "n1" },
      blocks: [],
      filters,
    }),
  });
}

describe("guardContentGroups", () => {
  const groups = [
    { selector: "ytd-rich-item-renderer", count: 24, samples: ["Lex Fridman Podcast"] },
    { selector: "ytd-rich-section-renderer", count: 1, samples: ["Podcasts"] },
  ];

  test("passes filters whose selector is a repeated group on the page", () => {
    const response = withFilters([{ itemSelector: "ytd-rich-item-renderer", keywords: ["podcast", "podcasts"], action: "hide" }]);
    expect(guardContentGroups(response, groups)).toBe(response);
  });

  test("blocks filters that name a selector the page did not have", () => {
    const response = withFilters([{ itemSelector: "ytd-video-renderer", keywords: ["podcast"], action: "hide" }]);
    expect(guardContentGroups(response, groups)).toEqual(BLOCKED_UNKNOWN_GROUPS);
    expect(BLOCKED_UNKNOWN_GROUPS).toEqual({ kind: "blocked", reason: "adaptation targeted content groups the page did not have" });
  });

  test("blocks filters when the outline sent no groups", () => {
    const response = withFilters([{ itemSelector: "ytd-rich-item-renderer", keywords: ["podcast"], action: "dim" }]);
    expect(guardContentGroups(response, undefined)).toEqual(BLOCKED_UNKNOWN_GROUPS);
  });

  test("answers without filters pass through", () => {
    const none: AdaptResponse = { kind: "none", reason: "nothing" };
    expect(guardContentGroups(none, undefined)).toBe(none);
    const noFilters = AdaptResponse.parse({
      kind: "adaptation",
      adaptation: { id: "a4", sites: ["example.com"], reason: { text: "bigger", needId: "n1" }, blocks: [{ block: "text_scale", scale: 1.3 }] },
    });
    expect(guardContentGroups(noFilters, undefined)).toBe(noFilters);
  });
});
