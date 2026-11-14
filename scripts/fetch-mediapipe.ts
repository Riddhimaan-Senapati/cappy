import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

const root = resolve(import.meta.dir, "..");
const out = join(root, "apps/extension/public/mediapipe");
const wasmOut = join(out, "wasm");
mkdirSync(wasmOut, { recursive: true });

const wasmSrc = join(dirname(Bun.resolveSync("@mediapipe/tasks-vision", join(root, "apps/extension"))), "wasm");
for (const file of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, file), join(wasmOut, file));

const modelPath = join(out, "hand_landmarker.task");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (!existsSync(modelPath) || sha(await Bun.file(modelPath).bytes()) !== MODEL_SHA256) {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha(bytes) !== MODEL_SHA256) throw new Error("hand_landmarker.task checksum mismatch");
  await Bun.write(modelPath, bytes);
}
console.log("mediapipe assets ready");
