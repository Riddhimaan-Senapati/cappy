export type Point = { x: number; y: number };

export type Frame = {
  t: number;
  wrist: Point;
  openPalm: boolean;
  fist: boolean;
};

export type Gesture = "scroll_down" | "scroll_up" | "back";

export type Landmark = { x: number; y: number; z?: number };

export const TOP_ZONE = 0.45;
export const PALM_HOLD_MS = 300;
export const BACK_WINDOW_MS = 500;
export const BACK_MIN_DISTANCE = 0.3;
export const DEBOUNCE_MS = 600;
const HISTORY_MS = 1000;

// Index, middle, ring, pinky as [tip, pip] landmark indices (MediaPipe hand model).
const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

export function landmarksToFrame(landmarks: readonly Landmark[], t: number): Frame {
  const wrist = landmarks[0];
  if (!wrist) throw new Error("landmarksToFrame needs the full hand landmark list");
  const dist = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);
  const extended = FINGERS.filter(([tip, pip]) => {
    const tipPt = landmarks[tip];
    const pipPt = landmarks[pip];
    return tipPt !== undefined && pipPt !== undefined && dist(tipPt, wrist) > dist(pipPt, wrist);
  }).length;
  return {
    t,
    wrist: { x: wrist.x, y: wrist.y },
    openPalm: extended >= 3,
    fist: extended <= 1,
  };
}

// Continuous hold rather than a single frame: MediaPipe flickers between poses on
// fingers that are partly curled, so one-frame matches would fire constantly.
function heldFor(history: readonly Frame[], matches: (f: Frame) => boolean): boolean {
  const last = history[history.length - 1];
  if (!last || !matches(last)) return false;
  let runStart = last.t;
  for (let i = history.length - 1; i >= 0; i--) {
    const frame = history[i];
    if (!frame || !matches(frame)) break;
    runStart = frame.t;
  }
  return last.t - runStart >= PALM_HOLD_MS;
}

export function classifyGesture(history: readonly Frame[]): Gesture | null {
  const last = history[history.length - 1];
  if (!last) return null;

  // Wrist x grows toward the user's left: the preview is mirrored, so this is what
  // the user sees as a leftward swipe.
  const earliest = history.find((f) => f.t >= last.t - BACK_WINDOW_MS) ?? last;
  if (last.wrist.x - earliest.wrist.x > BACK_MIN_DISTANCE) return "back";

  const inTopZone = (f: Frame) => f.wrist.y < TOP_ZONE;
  if (heldFor(history, (f) => f.openPalm && inTopZone(f))) return "scroll_down";
  if (heldFor(history, (f) => f.fist && inTopZone(f))) return "scroll_up";
  return null;
}

export type GestureDetector = {
  push(frame: Frame): Gesture | null;
  reset(): void;
};

export function createGestureDetector(): GestureDetector {
  let history: Frame[] = [];
  let lastEmitAt = Number.NEGATIVE_INFINITY;

  return {
    push(frame) {
      history = history.filter((f) => f.t > frame.t - HISTORY_MS);
      history.push(frame);
      const gesture = classifyGesture(history);
      if (!gesture) return null;
      if (frame.t - lastEmitAt < DEBOUNCE_MS) return null;
      lastEmitAt = frame.t;
      // A swipe is one back navigation; clearing stops the same movement firing again.
      if (gesture === "back") history = [];
      return gesture;
    },
    reset() {
      history = [];
      lastEmitAt = Number.NEGATIVE_INFINITY;
    },
  };
}
