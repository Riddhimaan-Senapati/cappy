export interface Point {
  x: number;
  y: number;
}

export type Pose = "open_palm" | "fist" | "thumbs_up" | "pinch" | "other";
export type SwipeName = "swipe_left" | "swipe_right" | "swipe_up" | "swipe_down";

const WRIST = 0;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const FINGERS: Array<[tip: number, pip: number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

function distance(a: Point, b: Point, aspect: number) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

export function classifyPose(landmarks: Point[], aspect = 1): Pose {
  if (landmarks.length < 21) return "other";
  const wrist = landmarks[WRIST];
  const handSize = distance(wrist, landmarks[MIDDLE_MCP], aspect);
  if (handSize < 0.01) return "other";

  if (distance(landmarks[4], landmarks[8], aspect) < 0.28 * handSize) return "pinch";

  const extended = FINGERS.map(([tip, pip]) => distance(landmarks[tip], wrist, aspect) > distance(landmarks[pip], wrist, aspect) * 1.05);
  const extendedCount = extended.filter(Boolean).length;
  const thumbExtended = distance(landmarks[4], landmarks[PINKY_MCP], aspect) > distance(landmarks[3], landmarks[PINKY_MCP], aspect) * 1.05;

  if (extendedCount === 4) return "open_palm";
  if (extendedCount === 0) {
    const thumbPointsUp = wrist.y - landmarks[4].y > 0.5 * handSize;
    return thumbExtended && thumbPointsUp ? "thumbs_up" : "fist";
  }
  return "other";
}

export function palmCenter(landmarks: Point[]): Point {
  const ids = [0, 5, 9, 13, 17];
  return { x: ids.reduce((sum, id) => sum + landmarks[id].x, 0) / ids.length, y: ids.reduce((sum, id) => sum + landmarks[id].y, 0) / ids.length };
}

export class SwipeDetector {
  private trail: Array<{ t: number; x: number; y: number }> = [];
  private lastFired = 0;

  constructor(
    private windowMs = 500,
    private distanceThreshold = 0.28,
    private cooldownMs = 900,
  ) {}

  reset() {
    this.trail = [];
  }

  push(t: number, point: Point): SwipeName | null {
    this.trail.push({ t, ...point });
    this.trail = this.trail.filter((sample) => t - sample.t <= this.windowMs);
    if (t - this.lastFired < this.cooldownMs || this.trail.length < 4) return null;

    const first = this.trail[0];
    const dx = point.x - first.x;
    const dy = point.y - first.y;
    let result: SwipeName | null = null;
    if (Math.abs(dx) > this.distanceThreshold && Math.abs(dx) > 2 * Math.abs(dy)) {
      // The camera image is not mirrored: moving toward the image's right is the user's left.
      result = dx > 0 ? "swipe_left" : "swipe_right";
    } else if (Math.abs(dy) > this.distanceThreshold && Math.abs(dy) > 2 * Math.abs(dx)) {
      result = dy < 0 ? "swipe_up" : "swipe_down";
    }
    if (result) {
      this.lastFired = t;
      this.trail = [];
    }
    return result;
  }
}

export class PoseStabilizer {
  private candidate: Pose = "other";
  private streak = 0;
  private stable: Pose = "other";
  private lastFired = 0;

  constructor(
    private framesNeeded = 3,
    private cooldownMs = 1000,
  ) {}

  push(t: number, pose: Pose): { stable: Pose; entered: Pose | null } {
    if (pose === this.candidate) this.streak++;
    else {
      this.candidate = pose;
      this.streak = 1;
    }
    let entered: Pose | null = null;
    if (this.streak >= this.framesNeeded && this.stable !== pose) {
      this.stable = pose;
      if (pose !== "other" && t - this.lastFired >= this.cooldownMs) {
        entered = pose;
        this.lastFired = t;
      }
    }
    return { stable: this.stable, entered };
  }

  clear() {
    this.candidate = "other";
    this.streak = 0;
    this.stable = "other";
  }
}
