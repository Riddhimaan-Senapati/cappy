import { expect, test } from "bun:test";
import { judgeByIssues } from "./verify";

test("fewer issues is improved, more is worse, same is no change", () => {
  expect(judgeByIssues(5, 2)).toBe("improved");
  expect(judgeByIssues(2, 5)).toBe("worse");
  expect(judgeByIssues(3, 3)).toBe("no_change");
  expect(judgeByIssues(0, 0)).toBe("no_change");
});
