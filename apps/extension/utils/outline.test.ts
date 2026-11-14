import { expect, test } from "bun:test";
import { PAGE_TEXT_MAX, buildPageText } from "./outline";

test("collapses whitespace and joins visible and hidden text", () => {
  expect(buildPageText("Hello\n\n  world", "Hello world  hidden   note")).toBe("Hello world Hello world hidden note");
});

test("caps the text at the page text limit", () => {
  expect(buildPageText("a".repeat(7000), "")).toHaveLength(PAGE_TEXT_MAX);
});
