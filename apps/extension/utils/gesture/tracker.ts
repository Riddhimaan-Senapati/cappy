import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createGestureDetector, landmarksToFrame, type Gesture } from "./classify";

export type GestureTracking = { stop(): void };

// Model and WASM ship inside the extension (public/mediapipe) so nothing is fetched from a CDN at runtime.
async function loadHandLandmarker(): Promise<HandLandmarker> {
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("mediapipe/wasm"));
  const modelAssetPath = chrome.runtime.getURL("mediapipe/hand_landmarker.task");
  const options = { runningMode: "VIDEO" as const, numHands: 1 };
  try {
    return await HandLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath, delegate: "GPU" },
    });
  } catch {
    return HandLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { modelAssetPath, delegate: "CPU" },
    });
  }
}

export async function startGestureTracking(
  video: HTMLVideoElement,
  onGesture: (gesture: Gesture) => void,
): Promise<GestureTracking> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } },
  });
  let landmarker: HandLandmarker | undefined;
  let frameId = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frameId);
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    landmarker?.close();
  };

  try {
    video.srcObject = stream;
    await video.play();
    landmarker = await loadHandLandmarker();
  } catch (err) {
    stop();
    throw err;
  }

  const detector = createGestureDetector();
  let lastVideoTime = -1;
  const loop = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime && landmarker) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const hand = landmarker.detectForVideo(video, now).landmarks[0];
      if (hand) {
        const gesture = detector.push(landmarksToFrame(hand, now));
        if (gesture) onGesture(gesture);
      } else {
        detector.reset();
      }
    }
    frameId = requestAnimationFrame(loop);
  };
  loop();

  return { stop };
}
