import type { TtsRequest, TtsStateMessage } from "../messages.js";
import { extractReadableText } from "./readable.js";

let speaking = false;
let listener: ((on: boolean) => void) | null = null;

export function speechActive() {
  return speaking;
}

export function onSpeechChange(callback: (on: boolean) => void) {
  listener = callback;
}

function setSpeaking(on: boolean) {
  if (speaking === on) return;
  speaking = on;
  listener?.(on);
}

export function readPageAloud(): boolean {
  const text = extractReadableText(document);
  if (!text) return false;
  void chrome.runtime.sendMessage({ type: "tts-speak", text, source: "page" } satisfies TtsRequest).catch(() => undefined);
  return true;
}

export function stopSpeech() {
  void chrome.runtime.sendMessage({ type: "tts-stop" } satisfies TtsRequest).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const state = message as Partial<TtsStateMessage>;
  if (state?.type === "tts-state") setSpeaking(Boolean(state.speaking));
  return false;
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && speaking) stopSpeech();
});
