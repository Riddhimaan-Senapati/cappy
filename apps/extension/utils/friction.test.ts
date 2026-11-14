import { describe, expect, test } from "bun:test";
import type { FrictionEvent } from "@browser-agent/shared";
import { FRICTION_WINDOW_MS, appendEvent, hostOf, shouldPrompt } from "./friction";

const zoomIn = (at: number): FrictionEvent => ({ kind: "zoom_in", host: "example.org", at });
const zoomOut = (at: number): FrictionEvent => ({ kind: "zoom_out", host: "example.org", at });
const NOW = 1_000_000;

describe("shouldPrompt", () => {
  test("needs two zoom-ins", () => {
    expect(shouldPrompt([zoomIn(NOW)], NOW)).toBe(false);
    expect(shouldPrompt([zoomIn(NOW - 1000), zoomIn(NOW)], NOW)).toBe(true);
  });

  test("ignores zoom-outs", () => {
    expect(shouldPrompt([zoomIn(NOW - 1000), zoomOut(NOW - 500), zoomOut(NOW)], NOW)).toBe(false);
  });

  test("zoom-ins outside the two minute window do not count", () => {
    const old = NOW - FRICTION_WINDOW_MS - 1;
    expect(shouldPrompt([zoomIn(old), zoomIn(NOW)], NOW)).toBe(false);
    expect(shouldPrompt([zoomIn(NOW - FRICTION_WINDOW_MS), zoomIn(NOW)], NOW)).toBe(true);
  });

  test("ignores events stamped in the future", () => {
    expect(shouldPrompt([zoomIn(NOW + 10), zoomIn(NOW)], NOW)).toBe(false);
  });
});

describe("appendEvent", () => {
  test("drops events outside the window and caps the list", () => {
    const stale = zoomIn(NOW - FRICTION_WINDOW_MS - 5);
    const next = appendEvent([stale, zoomIn(NOW - 10)], zoomIn(NOW), NOW);
    expect(next.map((e) => e.at)).toEqual([NOW - 10, NOW]);

    const many = Array.from({ length: 30 }, (_, i) => zoomIn(NOW - 100 + i));
    expect(appendEvent(many, zoomIn(NOW), NOW)).toHaveLength(20);
  });
});

describe("hostOf", () => {
  test("returns the hostname for web pages only", () => {
    expect(hostOf("https://news.example.org/a?b=1")).toBe("news.example.org");
    expect(hostOf("chrome://extensions")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
    expect(hostOf("not a url")).toBeUndefined();
  });
});
