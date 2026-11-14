import { load } from "../storage.js";

export async function requestAudio(path: "speech" | "transcribe" | "verify", body: BodyInit, type: string, signal?: AbortSignal, provider: "openai" | "gemini" = "openai", serverUrl?: string) {
  const url = new URL(serverUrl ?? (await load()).serverUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Local audio server required");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/api/audio/${path}`;
  url.search = new URLSearchParams({ provider }).toString();
  url.hash = "";
  const response = await fetch(url, { method: "POST", body, headers: { "Content-Type": type }, signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(result?.error ?? "Audio request failed");
  }
  return response;
}
