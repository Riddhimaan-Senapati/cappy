import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, "extension", "vendor");
const MODELS = {
  "hand_landmarker.task": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  "face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

mkdirSync(path.join(vendor, "mediapipe", "wasm"), { recursive: true });
cpSync(path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"), path.join(vendor, "mediapipe", "wasm"), { recursive: true });

for (const [file, url] of Object.entries(MODELS)) {
  const target = path.join(vendor, file);
  if (existsSync(target)) continue;
  console.log(`Downloading ${file}...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed for ${file}: ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}
console.log("Camera assets ready.");
