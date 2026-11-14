import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, "extension", "vendor");
const wasmSource = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmTarget = path.join(vendor, "mediapipe", "wasm");
const modelPath = path.join(vendor, "hand_landmarker.task");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

mkdirSync(wasmTarget, { recursive: true });
cpSync(wasmSource, wasmTarget, { recursive: true });

if (!existsSync(modelPath)) {
  console.log("Downloading hand tracking model (about 8 MB)...");
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  writeFileSync(modelPath, Buffer.from(await response.arrayBuffer()));
}
console.log("Gesture assets ready.");
