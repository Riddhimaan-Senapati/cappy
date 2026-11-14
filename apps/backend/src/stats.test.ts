import { expect, test } from "bun:test";
import type { PageStats } from "@browser-agent/shared";
import { describeStats, problemTotal, statsDeltas } from "./stats";

const ZERO: PageStats = {
  inputsWithoutLabel: 0,
  smallTargets: 0,
  smallText: 0,
  lowContrastText: 0,
  imagesWithoutAlt: 0,
  runningAnimations: 0,
  visibleAdsOrPopups: 0,
};

test("problemTotal sums every count", () => {
  expect(problemTotal(ZERO)).toBe(0);
  expect(problemTotal({ ...ZERO, smallText: 12, inputsWithoutLabel: 2 })).toBe(14);
});

test("statsDeltas lists only the keys that changed", () => {
  const before = { ...ZERO, smallText: 12, runningAnimations: 3 };
  const after = { ...ZERO, smallText: 0, runningAnimations: 3 };
  expect(statsDeltas(before, after)).toEqual([{ key: "smallText", before: 12, after: 0 }]);
  expect(statsDeltas(ZERO, ZERO)).toEqual([]);
});

test("describeStats names every count in one line", () => {
  const line = describeStats({ ...ZERO, smallText: 12 });
  expect(line).toContain("small text 12");
  expect(line).toContain("unlabeled inputs 0");
  expect(line.includes("\n")).toBe(false);
});
