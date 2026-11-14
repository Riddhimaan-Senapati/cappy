import { describe, expect, test } from "bun:test";
import { isTerminal, next, type VerifyState } from "./verify-machine";

const proposed: VerifyState = { tag: "proposed" };

describe("verify machine", () => {
  test("improved on the first check ends verified", () => {
    let s = next(proposed, { type: "applied" });
    expect(s).toEqual({ tag: "applied", attempt: 1 });
    s = next(s, { type: "verify_started" });
    expect(s).toEqual({ tag: "verifying", attempt: 1 });
    s = next(s, { type: "verdict", verdict: "improved" });
    expect(s).toEqual({ tag: "verified", attempt: 1 });
    expect(isTerminal(s)).toBe(true);
  });

  test("no_change on the first check retries, then improved on the retry verifies", () => {
    let s = next(next(proposed, { type: "applied" }), { type: "verify_started" });
    s = next(s, { type: "verdict", verdict: "no_change" });
    expect(s).toEqual({ tag: "retrying" });
    s = next(s, { type: "retry_done" });
    expect(s).toEqual({ tag: "applied", attempt: 2 });
    s = next(next(s, { type: "verify_started" }), { type: "verdict", verdict: "improved" });
    expect(s).toEqual({ tag: "verified", attempt: 2 });
  });

  test("worse on the first check retries, then worse on the retry rolls back", () => {
    let s = next(next(proposed, { type: "applied" }), { type: "verify_started" });
    s = next(s, { type: "verdict", verdict: "worse" });
    expect(s).toEqual({ tag: "retrying" });
    s = next(s, { type: "retry_done" });
    s = next(next(s, { type: "verify_started" }), { type: "verdict", verdict: "worse" });
    expect(s).toEqual({ tag: "rolling_back" });
    s = next(s, { type: "rollback_done" });
    expect(s).toEqual({ tag: "rolled_back" });
    expect(isTerminal(s)).toBe(true);
  });

  test("no_change on the retry rolls back", () => {
    let s = next(next(proposed, { type: "applied" }), { type: "verify_started" });
    s = next(next(next(s, { type: "verdict", verdict: "worse" }), { type: "retry_done" }), { type: "verify_started" });
    s = next(s, { type: "verdict", verdict: "no_change" });
    expect(s).toEqual({ tag: "rolling_back" });
  });

  test("a retry that cannot be re-applied rolls back without verifying again", () => {
    let s = next(next(proposed, { type: "applied" }), { type: "verify_started" });
    s = next(s, { type: "verdict", verdict: "no_change" });
    s = next(s, { type: "rollback_done" });
    expect(s).toEqual({ tag: "rolled_back" });
  });

  test("rejects events that do not apply to the current state", () => {
    expect(() => next(proposed, { type: "verify_started" })).toThrow();
    expect(() => next(proposed, { type: "verdict", verdict: "improved" })).toThrow();
    expect(() => next({ tag: "verifying", attempt: 1 }, { type: "retry_done" })).toThrow();
    expect(() => next({ tag: "retrying" }, { type: "verdict", verdict: "improved" })).toThrow();
    expect(() => next({ tag: "verified", attempt: 1 }, { type: "rollback_done" })).toThrow();
    expect(() => next({ tag: "rolled_back" }, { type: "applied" })).toThrow();
  });

  test("non-terminal states are not terminal", () => {
    expect(isTerminal(proposed)).toBe(false);
    expect(isTerminal({ tag: "retrying" })).toBe(false);
    expect(isTerminal({ tag: "rolling_back" })).toBe(false);
  });
});
