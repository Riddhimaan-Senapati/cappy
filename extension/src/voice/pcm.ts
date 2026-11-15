// GPT-Live audio is mono PCM16 little-endian at LIVE_RATE in both directions.
import type { LiveToClient } from "../../../shared/protocol.js";

export { LIVE_RATE } from "../../../shared/protocol.js";

export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return out.buffer;
}

export function pcm16ToFloat(bytes: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

// The agent socket is ws://host/agent; the live conversation is on /live of the same server.
export function liveUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = "/live";
  url.search = "";
  return url.toString();
}

// Server messages on the /live socket; anything malformed is dropped.
export function parseLiveMessage(raw: string): LiveToClient | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  switch (value.type) {
    case "ready":
    case "closed":
      return { type: value.type };
    case "heard":
      return text("text") === null ? null : { type: "heard", text: text("text")! };
    case "said":
      return text("delta") === null ? null : { type: "said", delta: text("delta")! };
    case "error":
      return { type: "error", message: text("message") ?? "" };
    case "task":
      return text("id") === null || text("text") === null ? null : { type: "task", id: text("id")!, text: text("text")! };
    default:
      return null;
  }
}
