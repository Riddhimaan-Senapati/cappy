import { expect, test } from "bun:test";
import { judgeByIssues, judgeByStats } from "./verify";

test("fewer issues is improved, more is worse, same is no change", () => {
  expect(judgeByIssues(5, 2)).toBe("improved");
  expect(judgeByIssues(2, 5)).toBe("worse");
  expect(judgeByIssues(3, 3)).toBe("no_change");
  expect(judgeByIssues(0, 0)).toBe("no_change");
});

test("measured problems decide when the stats fell or rose", () => {
  const base = { inputsWithoutLabel: 0, smallTargets: 0, smallText: 12, lowContrastText: 0, imagesWithoutAlt: 0, runningAnimations: 0, visibleAdsOrPopups: 0 };
  expect(judgeByStats(base, { ...base, smallText: 0 })).toBe("improved");
  expect(judgeByStats(base, { ...base, smallText: 14 })).toBe("worse");
});
