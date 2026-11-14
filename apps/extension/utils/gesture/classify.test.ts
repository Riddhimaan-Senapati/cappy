import { describe, expect, test } from "bun:test";
import {
  classifyGesture,
  createGestureDetector,
  landmarksToFrame,
  type Frame,
  type Landmark,
} from "./classify";

const STEP_MS = 50;

function frames(
  count: number,
  make: (i: number) => Omit<Frame, "t">,
  start = 0,
): Frame[] {
  return Array.from({ length: count }, (_, i) => ({ t: start + i * STEP_MS, ...make(i) }));
}

const palmTop = { wrist: { x: 0.5, y: 0.2 }, openPalm: true, fist: false };
const fistTop = { wrist: { x: 0.5, y: 0.2 }, openPalm: false, fist: true };

describe("classifyGesture", () => {
  test("open palm in the top zone held 300ms scrolls down", () => {
    const history = frames(9, () => palmTop); // spans 400ms
    expect(classifyGesture(history)).toBe("scroll_down");
  });

  test("open palm held for less than 300ms does nothing", () => {
    const history = frames(5, () => palmTop); // spans 200ms
    expect(classifyGesture(history)).toBeNull();
  });

  test("open palm below the top 45% of the frame does nothing", () => {
    const history = frames(9, () => ({ ...palmTop, wrist: { x: 0.5, y: 0.6 } }));
    expect(classifyGesture(history)).toBeNull();
  });

  test("a fist in the top zone held 300ms scrolls up", () => {
    const history = frames(9, () => fistTop);
    expect(classifyGesture(history)).toBe("scroll_up");
  });

  test("a palm that is interrupted restarts the hold", () => {
    const history = [
      ...frames(9, () => palmTop, 0),
      { t: 450, ...fistTop },
      ...frames(4, () => palmTop, 500), // only 150ms since the interruption
    ];
    expect(classifyGesture(history)).toBeNull();
  });

  test("wrist moving more than 0.3 of width within 500ms is back", () => {
    const history = frames(9, (i) => ({
      wrist: { x: 0.3 + i * 0.05, y: 0.7 },
      openPalm: false,
      fist: false,
    })); // 0.4 travel over 400ms
    expect(classifyGesture(history)).toBe("back");
  });

  test("a slow wrist movement is not back", () => {
    const history = frames(25, (i) => ({
      wrist: { x: 0.3 + i * 0.02, y: 0.7 },
      openPalm: false,
      fist: false,
    })); // 0.48 travel over 1200ms, only ~0.2 inside any 500ms window
    expect(classifyGesture(history)).toBeNull();
  });

  test("empty history yields nothing", () => {
    expect(classifyGesture([])).toBeNull();
  });
});

describe("createGestureDetector", () => {
  test("emits at most one action per 600ms", () => {
    const detector = createGestureDetector();
    const emitted: Array<[number, string]> = [];
    for (let t = 0; t <= 1500; t += 33) {
      const g = detector.push({ t, ...palmTop });
      if (g) emitted.push([t, g]);
    }
    const times = emitted.map(([t]) => t);
    expect(emitted.every(([, g]) => g === "scroll_down")).toBe(true);
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(600);
    }
    expect(times[0] ?? 0).toBeGreaterThanOrEqual(300);
  });

  test("a second gesture inside the debounce window is dropped", () => {
    const detector = createGestureDetector();
    let first: string | null = null;
    for (let t = 0; t <= 400; t += 50) first ??= detector.push({ t, ...palmTop });
    expect(first).toBe("scroll_down");
    // Fist held in the top zone right after: still inside the 600ms window, so nothing.
    const during = [];
    for (let t = 450; t <= 800; t += 50) during.push(detector.push({ t, ...fistTop }));
    expect(during.filter(Boolean)).toHaveLength(0);
  });

  test("a back swipe fires once and does not repeat for the same movement", () => {
    const detector = createGestureDetector();
    const results: Array<string | null> = [];
    for (let i = 0; i <= 12; i++) {
      results.push(
        detector.push({
          t: i * 50,
          wrist: { x: 0.2 + i * 0.05, y: 0.7 },
          openPalm: false,
          fist: false,
        }),
      );
    }
    expect(results.filter((g) => g === "back")).toHaveLength(1);
  });

  test("reset clears history and debounce", () => {
    const detector = createGestureDetector();
    for (let t = 0; t <= 400; t += 50) detector.push({ t, ...palmTop });
    detector.reset();
    expect(detector.push({ t: 410, ...palmTop })).toBeNull();
  });
});

describe("landmarksToFrame", () => {
  // Build 21 landmarks with the wrist at (x, y) and each finger either extended
  // (tip far from wrist) or curled (tip folded back toward the wrist).
  function hand(x: number, y: number, extended: boolean[]): Landmark[] {
    const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x, y: y - 0.05 }));
    lm[0] = { x, y };
    const fingers: Array<[number, number]> = [
      [8, 6],
      [12, 10],
      [16, 14],
      [20, 18],
    ];
    fingers.forEach(([tip, pip], i) => {
      lm[pip] = { x, y: y - 0.1 };
      lm[tip] = extended[i] ? { x, y: y - 0.3 } : { x, y: y - 0.05 };
    });
    return lm;
  }

  test("all four fingers extended is an open palm", () => {
    const f = landmarksToFrame(hand(0.5, 0.5, [true, true, true, true]), 10);
    expect(f).toMatchObject({ t: 10, openPalm: true, fist: false });
    expect(f.wrist).toEqual({ x: 0.5, y: 0.5 });
  });

  test("no fingers extended is a fist", () => {
    const f = landmarksToFrame(hand(0.5, 0.5, [false, false, false, false]), 0);
    expect(f).toMatchObject({ openPalm: false, fist: true });
  });

  test("two extended fingers is neither", () => {
    const f = landmarksToFrame(hand(0.5, 0.5, [true, true, false, false]), 0);
    expect(f).toMatchObject({ openPalm: false, fist: false });
  });
});
