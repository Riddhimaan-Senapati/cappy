export interface Point {
  x: number;
  y: number;
}

export type HandPose = "point" | "open" | "fist" | "pinch" | "thumbs_down" | "other";

export interface HandFrame {
  pose: HandPose;
  index: Point;
  knuckle: Point;
  palm: Point;
  pinch: number;
}

export interface HeadFrame {
  pitch: number;
  yaw: number;
}

const WRIST = 0;
const FINGERS: Array<[tip: number, pip: number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

const distance = (a: Point, b: Point, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

export function readHand(landmarks: Point[], aspect = 1): HandFrame | null {
  if (landmarks.length < 21) return null;
  const wrist = landmarks[WRIST];
  const handSize = distance(wrist, landmarks[9], aspect);
  if (handSize < 0.02) return null;

  const extended = FINGERS.map(([tip, pip]) => distance(landmarks[tip], wrist, aspect) > distance(landmarks[pip], wrist, aspect) * 1.05);
  const pinch = distance(landmarks[4], landmarks[8], aspect) / handSize;
  const palmIds = [0, 5, 9, 13, 17];
  const palm = { x: palmIds.reduce((sum, id) => sum + landmarks[id].x, 0) / 5, y: palmIds.reduce((sum, id) => sum + landmarks[id].y, 0) / 5 };

  const thumbExtended = distance(landmarks[4], landmarks[17], aspect) > distance(landmarks[3], landmarks[17], aspect) * 1.05;
  const lowest = Math.max(wrist.y, landmarks[5].y, landmarks[9].y, landmarks[13].y, landmarks[17].y);
  const thumbDown = thumbExtended && landmarks[4].y > lowest + 0.25 * handSize;

  let pose: HandPose = "other";
  if (!extended.some(Boolean) && thumbDown) pose = "thumbs_down";
  // In a real pinch the index still reaches out from the palm; in a fist with the thumb tucked it is curled in.
  else if (pinch < 0.3 && !extended[2] && !extended[3] && distance(landmarks[8], wrist, aspect) > 1.1 * handSize) pose = "pinch";
  else if (extended.every(Boolean)) pose = "open";
  else if (extended[0] && !extended[1] && !extended[2] && !extended[3]) pose = "point";
  else if (!extended.some(Boolean)) pose = "fist";

  return { pose, index: landmarks[8], knuckle: landmarks[5], palm, pinch };
}

// Head pose from face mesh landmarks: 1 nose tip, 10 forehead, 152 chin, 33 and 263 outer eye corners.
export function readHead(landmarks: Point[]): HeadFrame | null {
  if (landmarks.length < 264) return null;
  const nose = landmarks[1];
  const top = landmarks[10];
  const chin = landmarks[152];
  const left = landmarks[33];
  const right = landmarks[263];
  const faceHeight = chin.y - top.y;
  const eyeSpan = right.x - left.x;
  if (Math.abs(faceHeight) < 0.02 || Math.abs(eyeSpan) < 0.02) return null;
  return {
    pitch: (nose.y - (top.y + chin.y) / 2) / faceHeight,
    yaw: (nose.x - (left.x + right.x) / 2) / eyeSpan,
  };
}
