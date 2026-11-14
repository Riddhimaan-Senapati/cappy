// Decides when the user has finished speaking, from microphone loudness alone, so it works for every voice provider.
export const ENDPOINT = {
  pauseMs: 1200,
  noSpeechMs: 6000,
  maxMs: 15_000,
  minSpeechLevel: 0.02,
  floorRatio: 3,
  speechFrames: 2,
};

export interface EndpointState {
  startedAt: number;
  floor: number;
  heardSpeech: boolean;
  speaking: boolean;
  loudFrames: number;
  silentSince: number | null;
}

// "pause" starts the about-to-send countdown, "resume" cancels it, "stop" ends listening.
export type EndpointSignal = { type: "pause"; ms: number } | { type: "resume" } | { type: "stop"; reason: "pause" | "no-speech" | "max" } | null;

export const startEndpoint = (now: number): EndpointState => ({ startedAt: now, floor: 0.01, heardSpeech: false, speaking: false, loudFrames: 0, silentSince: null });

// hold: the user is holding a pinch (push-to-talk), so pauses never end listening; only release, the keyword or the cap do.
export function stepEndpoint(state: EndpointState, level: number, now: number, hold = false, pauseMs = ENDPOINT.pauseMs): { state: EndpointState; signal: EndpointSignal } {
  if (now - state.startedAt >= ENDPOINT.maxMs) return { state, signal: { type: "stop", reason: "max" } };
  const threshold = Math.max(ENDPOINT.minSpeechLevel, state.floor * ENDPOINT.floorRatio);
  const loud = level >= threshold;
  // The noise floor follows quiet frames only, slowly, so a steady fan or hum does not count as speech.
  const floor = loud ? state.floor : state.floor * 0.95 + level * 0.05;
  const loudFrames = loud ? state.loudFrames + 1 : 0;
  const next: EndpointState = { ...state, floor, loudFrames };

  if (loudFrames >= ENDPOINT.speechFrames) {
    const wasPaused = next.heardSpeech && next.silentSince !== null;
    next.heardSpeech = true;
    next.speaking = true;
    next.silentSince = null;
    return { state: next, signal: wasPaused ? { type: "resume" } : null };
  }
  if (loud) return { state: next, signal: null };

  if (!next.heardSpeech) {
    if (!hold && now - state.startedAt >= ENDPOINT.noSpeechMs) return { state: next, signal: { type: "stop", reason: "no-speech" } };
    return { state: next, signal: null };
  }
  if (next.silentSince === null) {
    next.speaking = false;
    next.silentSince = now;
    return { state: next, signal: hold ? null : { type: "pause", ms: pauseMs } };
  }
  if (!hold && now - next.silentSince >= pauseMs) return { state: next, signal: { type: "stop", reason: "pause" } };
  return { state: next, signal: null };
}

const DONE = /[\s,.;:!?-]*\b(?:done|send it)[.!?]*\s*$/i;

// Saying "done" (or "send it") at the end finishes the request; the keyword itself is not part of it.
export function stripDoneKeyword(text: string): { text: string; done: boolean } {
  const trimmed = text.trim();
  if (!DONE.test(trimmed)) return { text: trimmed, done: false };
  return { text: trimmed.replace(DONE, "").trim(), done: true };
}
