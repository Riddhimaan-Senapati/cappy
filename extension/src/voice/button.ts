import { h, icon } from "../ui/dom.js";
import type { VoiceState } from "./core.js";

export function micButton(): HTMLButtonElement {
  const button = h("button", "mic");
  button.type = "button";
  button.setAttribute("aria-label", "Speak");
  button.setAttribute("aria-pressed", "false");
  button.title = "Speak (Alt+M)";
  button.append(icon("mic", 16));
  return button;
}

export function paintMic(button: HTMLButtonElement, state: VoiceState) {
  button.setAttribute("aria-pressed", String(state.phase === "starting" || state.phase === "listening" || state.phase === "stopping"));
  button.dataset.phase = state.phase;
}

export function liveRegion(): HTMLSpanElement {
  const region = h("span", "sr-only");
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  return region;
}
