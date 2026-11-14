import { h, icon } from "../ui/dom.js";
import type { VoiceState } from "./core.js";

export function micButton(): HTMLButtonElement {
  const button = h("button", "mic");
  button.type = "button";
  button.setAttribute("aria-label", "Speak");
  button.setAttribute("aria-pressed", "false");
  button.title = "Speak (Alt+M)";
  button.append(icon("mic", 16), countdownRing());
  return button;
}

const SVG = "http://www.w3.org/2000/svg";

export function countdownRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "count-ring");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG, "circle");
  for (const [name, value] of [["cx", "18"], ["cy", "18"], ["r", "16"], ["pathLength", "100"]]) circle.setAttribute(name, value);
  svg.append(circle);
  return svg;
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

// A ring that drains over the final pause; restarting the animation needs a reflow, hence the offsetWidth read.
export function paintCountdown(element: HTMLElement, ms: number | null) {
  element.classList.remove("counting");
  if (ms === null) return;
  element.style.setProperty("--countdown", `${ms}ms`);
  void element.offsetWidth;
  element.classList.add("counting");
}
