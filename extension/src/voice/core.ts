export type VoicePhase = "idle" | "starting" | "listening" | "stopping" | "error";

export interface VoiceState {
  phase: VoicePhase;
  error?: string;
}

export type VoiceEvent =
  | { type: "listening" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; error: string }
  | { type: "ended" };

export type VoiceInput = { type: "start" } | { type: "stop" } | VoiceEvent;

export const VOICE_IDLE: VoiceState = { phase: "idle" };

const MAX_TEXT = 4000;
const MAX_ERROR = 64;
const ERROR_PATTERN = /^[a-z-]+$/;

export function reduceVoice(state: VoiceState, input: VoiceInput): VoiceState {
  switch (input.type) {
    case "start":
      if (state.phase === "idle" || state.phase === "error") return { phase: "starting" };
      return state;
    case "stop":
      if (state.phase === "starting" || state.phase === "listening") return { phase: "stopping" };
      return state;
    case "listening":
      return state.phase === "starting" ? { phase: "listening" } : state;
    case "error":
      return { phase: "error", error: input.error };
    case "ended":
      return state.phase === "error" ? state : VOICE_IDLE;
    case "interim":
    case "final":
      return state;
  }
}

export function isVoiceActive(state: VoiceState): boolean {
  return state.phase === "starting" || state.phase === "listening" || state.phase === "stopping";
}

export function parseVoiceEvent(value: unknown): VoiceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "listening":
    case "ended":
      return { type: record.type };
    case "interim":
    case "final":
      if (typeof record.text !== "string") return null;
      return { type: record.type, text: record.text.slice(0, MAX_TEXT) };
    case "error":
      if (typeof record.error !== "string" || record.error.length > MAX_ERROR || !ERROR_PATTERN.test(record.error)) return null;
      return { type: "error", error: record.error };
    default:
      return null;
  }
}

export function voiceErrorText(error: string): string {
  switch (error) {
    case "microphone-setup":
      return "Allow microphone access in Chrome, then try again.";
    case "not-allowed":
      return "Microphone access is blocked for Adaptive Browser Agent. Check Chrome and your system microphone permissions.";
    case "service-not-allowed":
      return "Chrome's speech service is turned off for this browser.";
    case "aborted":
      return "Voice input stopped.";
    case "no-speech":
      return "Didn't hear anything. Try again.";
    case "microphone-unavailable":
      return "Chrome found a microphone but could not open it. Check your system microphone settings and try again.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "The speech service could not be reached. Check your connection.";
    case "language-not-supported":
      return "Speech recognition does not support this language yet.";
    case "gemini-audio":
      return "Gemini transcription failed. Check the Gemini API key and local server.";
    case "openai-audio":
      return "OpenAI audio failed. Check the OpenAI API key and local server.";
    case "start-failed":
      return "Could not start voice input. Check microphone access in Settings and try again.";
    case "unsupported":
      return "Voice input is not supported in this browser.";
    default:
      return `Voice input stopped (${error}).`;
  }
}

export function joinVoiceText(base: string, spoken: string): string {
  const head = base.trimEnd();
  const tail = spoken.trim();
  if (!tail) return head;
  return head ? `${head} ${tail}` : tail;
}

export function voiceStatusText(state: VoiceState): string {
  switch (state.phase) {
    case "idle":
      return "Stopped";
    case "starting":
      return "Starting the microphone";
    case "listening":
      return "Listening";
    case "stopping":
      return "Stopping";
    case "error":
      return voiceErrorText(state.error ?? "");
  }
}
