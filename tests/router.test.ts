import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRequest } from "../shared/protocol.js";
import { pickTier } from "../server/agent/router.js";

const chat = (message: string) => ({ routing: "auto", trigger: "chat", message }) as RunRequest;

test("short content filter requests stay on the fast tier", () => {
  for (const message of ["hide gaming videos", "only show recipes and hide ads", "Only show news about science", "hide posts about crypto"]) {
    assert.equal(pickTier(chat(message)), "fast", message);
  }
});

test("structural requests still go to frontier", () => {
  assert.equal(pickTier(chat("sort these videos alphabetically")), "frontier");
  assert.equal(pickTier(chat("fix this form")), "frontier");
});

test("explicit routing wins", () => {
  assert.equal(pickTier({ ...chat("sort these"), routing: "fast" } as RunRequest), "fast");
});
