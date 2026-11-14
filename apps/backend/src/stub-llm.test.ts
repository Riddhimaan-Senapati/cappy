import { expect, test } from "bun:test";
import { stubReply } from "./stub-llm";

const ask = (content: string) =>
  JSON.parse(stubReply({ messages: [{ role: "user", content }], jsonSchema: { type: "object" } }).text);

test("free-text preferences become preference proposals", () => {
  expect(ask("I prefer dark mode on every site").proposal).toEqual({
    kind: "preference",
    detail: "prefer dark mode on every site",
    why: "You told me this preference",
  });
  expect(ask("I hate autoplaying videos").proposal.kind).toBe("preference");
});

test("plain chatter proposes nothing", () => {
  expect(ask("hello there").proposal).toBeNull();
});
