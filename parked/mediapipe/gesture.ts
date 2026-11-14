import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { classifyPose, palmCenter, PoseStabilizer, SwipeDetector } from "./classify.js";

const video = document.querySelector("video")!;
const canvas = document.querySelector("canvas")!;
const status = document.querySelector<HTMLElement>(".status")!;
const context = canvas.getContext("2d")!;

const post = (message: Record<string, unknown>) => parent.postMessage({ ba: "gesture", ...message }, "*");

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function setStatus(text: string) {
  status.textContent = text;
  status.hidden = !text;
}

function draw(landmarks: NormalizedLandmark[] | null) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;
  context.strokeStyle = "rgba(140, 160, 255, 0.95)";
  context.lineWidth = 2;
  context.beginPath();
  for (const [a, b] of CONNECTIONS) {
    context.moveTo(landmarks[a].x * canvas.width, landmarks[a].y * canvas.height);
    context.lineTo(landmarks[b].x * canvas.width, landmarks[b].y * canvas.height);
  }
  context.stroke();
  context.fillStyle = "#fff";
  for (const point of landmarks) {
    context.beginPath();
    context.arc(point.x * canvas.width, point.y * canvas.height, 2.5, 0, Math.PI * 2);
    context.fill();
  }
}

async function createLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/mediapipe/wasm"));
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: chrome.runtime.getURL("vendor/hand_landmarker.task"), delegate },
    runningMode: "VIDEO" as const,
    numHands: 1,
  });
  try {
    return await HandLandmarker.createFromOptions(vision, options("GPU"));
  } catch {
    return HandLandmarker.createFromOptions(vision, options("CPU"));
  }
}

async function main() {
  setStatus("Starting camera");
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false });
    await video.play();
  } catch {
    setStatus("Camera blocked. Allow camera access for this extension.");
    post({ type: "status", state: "blocked" });
    return;
  }

  setStatus("Loading hand tracking");
  let landmarker: HandLandmarker;
  try {
    landmarker = await createLandmarker();
  } catch (error) {
    setStatus("Hand tracking failed to load");
    post({ type: "status", state: "failed", detail: String(error) });
    return;
  }
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 240;
  setStatus("");
  post({ type: "status", state: "ready" });

  const swipes = new SwipeDetector();
  const poses = new PoseStabilizer();
  let lastVideoTime = -1;
  let lastPost = 0;
  let wasPresent = false;

  const tick = () => {
    requestAnimationFrame(tick);
    if (video.currentTime === lastVideoTime || video.readyState < 2) return;
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    const landmarks = result.landmarks[0] ?? null;
    draw(landmarks);

    if (!landmarks) {
      if (wasPresent) post({ type: "frame", present: false });
      wasPresent = false;
      swipes.reset();
      poses.clear();
      return;
    }
    wasPresent = true;
    const aspect = video.videoWidth / Math.max(1, video.videoHeight);
    const pose = classifyPose(landmarks, aspect);
    const center = palmCenter(landmarks);
    const { stable, entered } = poses.push(now, pose);

    if (now - lastPost > 40) {
      lastPost = now;
      post({ type: "frame", present: true, pose: stable, x: center.x, y: center.y });
    }
    if (entered) post({ type: "event", name: entered });
    const swipe = stable === "open_palm" ? swipes.push(now, center) : (swipes.reset(), null);
    if (swipe) post({ type: "event", name: swipe });
  };
  requestAnimationFrame(tick);
}

void main();
