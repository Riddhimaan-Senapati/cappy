import { describe, expect, test } from "bun:test";
import { clientTime, now, onClockChange, setDebugNow } from "./clock";

describe("clock", () => {
  test("now follows the debug override and falls back to the real clock", () => {
    setDebugNow("2026-11-16T10:00:00.000Z");
    expect(now().toISOString()).toBe("2026-11-16T10:00:00.000Z");
    setDebugNow("not a date");
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
    setDebugNow(undefined);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });

  test("a change notifies listeners until they unsubscribe", () => {
    let calls = 0;
    const off = onClockChange(() => {
      calls += 1;
    });
    setDebugNow("2026-11-16T10:00:00.000Z");
    off();
    setDebugNow(undefined);
    expect(calls).toBe(1);
  });

  test("clientTime carries the faked instant and a time zone", () => {
    setDebugNow("2026-11-16T10:00:00.000Z");
    const time = clientTime();
    expect(time.iso).toBe("2026-11-16T10:00:00.000Z");
    expect(time.timeZone.length).toBeGreaterThan(0);
    setDebugNow(undefined);
  });
});
