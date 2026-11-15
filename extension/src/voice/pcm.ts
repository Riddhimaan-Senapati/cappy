// GPT-Live audio is mono PCM16 little-endian at 24 kHz in both directions.
export const LIVE_RATE = 24_000;

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

export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

// The agent socket is ws://host/agent; the live conversation is on /live of the same server.
export function liveUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = "/live";
  url.search = "";
  return url.toString();
}
