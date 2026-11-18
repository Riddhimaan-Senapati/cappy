import { FaceLandmarker, FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { readHand, readHead } from "./vision.js";

const params = new URLSearchParams(location.search);
const wantHand = params.get("hand") !== "0";
const wantHead = params.get("head") === "1";

const video = document.querySelector("video")!;
const canvas = document.querySelector("canvas")!;
const status = document.querySelector<HTMLElement>(".status")!;
const context = canvas.getContext("2d")!;

const post = (message: Record<string, unknown>) => void chrome.runtime.sendMessage({ ba: "camera", ...message }).catch(() => undefined);

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

function setStatus(text: string) {
  status.textContent = text;
  status.hidden = !text;
}

function draw(hand: NormalizedLandmark[] | null) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!hand) return;
  context.strokeStyle = "rgba(150, 165, 255, 0.95)";
  context.lineWidth = 2;
  context.beginPath();
  for (const [a, b] of BONES) {
    context.moveTo(hand[a].x * canvas.width, hand[a].y * canvas.height);
    context.lineTo(hand[b].x * canvas.width, hand[b].y * canvas.height);
  }
  context.stroke();
}

async function createModels() {
  const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/mediapipe/wasm"));
  const base = (model: string, delegate: "GPU" | "CPU") => ({ modelAssetPath: chrome.runtime.getURL(`vendor/${model}`), delegate });
  const make = async <T>(create: (delegate: "GPU" | "CPU") => Promise<T>) => {
    try {
      return await create("GPU");
    } catch {
      return create("CPU");
    }
  };
  const hand = wantHand ? await make((delegate) => HandLandmarker.createFromOptions(files, { baseOptions: base("hand_landmarker.task", delegate), runningMode: "VIDEO", numHands: 1 })) : null;
  const face = wantHead ? await make((delegate) => FaceLandmarker.createFromOptions(files, { baseOptions: base("face_landmarker.task", delegate), runningMode: "VIDEO", numFaces: 1 })) : null;
  return { hand, face };
}

async function main() {
  setStatus("Starting camera");
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false });
    await video.play();
  } catch {
    setStatus("Camera blocked. Allow camera access for this extension.");
    return post({ type: "status", state: "blocked" });
  }

  setStatus("Loading tracking");
  let models: Awaited<ReturnType<typeof createModels>>;
  try {
    models = await createModels();
  } catch (error) {
    setStatus("Tracking failed to load");
    return post({ type: "status", state: "failed", detail: String(error) });
  }
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 240;
  setStatus("");
  post({ type: "status", state: "ready" });

  let lastTime = -1;
  const aspect = (video.videoWidth || 320) / (video.videoHeight || 240);
  const tick = () => {
    requestAnimationFrame(tick);
    if (video.readyState < 2 || video.currentTime === lastTime) return;
    lastTime = video.currentTime;
    const now = performance.now();
    const handLandmarks = models.hand?.detectForVideo(video, now).landmarks[0] ?? null;
    const faceLandmarks = models.face?.detectForVideo(video, now).faceLandmarks[0] ?? null;
    draw(handLandmarks);
    post({ type: "frame", t: now, hand: handLandmarks ? readHand(handLandmarks, aspect) : null, head: faceLandmarks ? readHead(faceLandmarks) : null });
  };
  requestAnimationFrame(tick);
}

void main();
