import type { BackgroundRequest } from "../messages.js";
import { load } from "../storage.js";
import { VOICE_IDLE, isVoiceActive, reduceVoice, type VoiceEvent, type VoiceState } from "./core.js";

const STOP_TIMEOUT_MS = 4000;

export interface VoiceCallbacks {
  onState(state: VoiceState): void;
  onInterim(text: string): void;
  onFinal(text: string): void;
  // The about-to-send countdown: ms until listening ends, or null when speech resumed or listening stopped.
  onCountdown?(ms: number | null): void;
}

export class VoiceController {
  private state: VoiceState = VOICE_IDLE;
  private launching = false;
  private stopTimer: number | undefined;

  constructor(private callbacks: VoiceCallbacks) {}

  get phase() {
    return this.state.phase;
  }

  get active() {
    return isVoiceActive(this.state);
  }

  async start(options: { hold?: boolean } = {}) {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    this.launching = true;
    this.apply(reduceVoice(this.state, { type: "start" }));
    try {
      const { voiceLang } = await load();
      if (!this.launching) return;
      this.launching = false;
      const accepted = await chrome.runtime.sendMessage({ kind: "voiceStart", lang: voiceLang, hold: options.hold } satisfies BackgroundRequest);
      if (accepted !== true) throw new Error("Voice start was not acknowledged");
    } catch {
      this.launching = false;
      if (this.phase === "starting") this.apply(reduceVoice(this.state, { type: "error", error: "start-failed" }));
    }
  }

  stop() {
    if (this.launching) {
      this.launching = false;
      this.apply(VOICE_IDLE);
      return;
    }
    if (!this.active) return;
    this.apply(reduceVoice(this.state, { type: "stop" }));
    void chrome.runtime.sendMessage({ kind: "voiceStop" } satisfies BackgroundRequest).catch(() => undefined);
  }

  receive(event: VoiceEvent) {
    if (event.type === "interim") return this.callbacks.onInterim(event.text);
    if (event.type === "final") return this.callbacks.onFinal(event.text);
    if (event.type === "pause") return this.callbacks.onCountdown?.(event.ms);
    if (event.type === "resume") return this.callbacks.onCountdown?.(null);
    this.apply(reduceVoice(this.state, event));
  }

  private apply(next: VoiceState) {
    if (next === this.state) return;
    window.clearTimeout(this.stopTimer);
    this.state = next;
    if (next.phase !== "listening") this.callbacks.onCountdown?.(null);
    if (next.phase === "stopping") this.stopTimer = window.setTimeout(() => this.apply(VOICE_IDLE), STOP_TIMEOUT_MS);
    this.callbacks.onState(next);
  }
}
