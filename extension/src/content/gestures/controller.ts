import type { HandFrame, HeadFrame } from "../../camera/vision.js";
import type { CameraSettings } from "../../storage.js";
import { OWN_ATTR } from "../dom.js";
import { OneEuroFilter } from "./filter.js";

export interface CameraHooks {
  notify(text: string): void;
  turnOff(): void;
}

const CSS = `
:host { all: initial; }
.pip { position: fixed; left: 16px; bottom: 16px; width: 184px; border-radius: 14px; overflow: hidden; pointer-events: auto; background: #0e0e12;
  border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 36px rgba(0,0,0,.45); font: 12px system-ui, sans-serif; color: #e8e8ee; animation: in .35s cubic-bezier(.2,.9,.3,1.15); }
@keyframes in { from { opacity: 0; transform: translateY(10px) scale(.96); } }
iframe { display: block; width: 184px; height: 138px; border: 0; }
.bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; flex: none; }
.dot.paused { background: #fbbf24; } .dot.idle { background: rgba(255,255,255,.3); }
.mode { flex: 1; color: #c9c9d3; }
.off { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #9a9aa6; }
.off:hover { color: #fff; background: rgba(255,255,255,.1); }
.off:focus-visible { outline: 2px solid #8b9bff; }
.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; pointer-events: none;
  border: 2.5px solid #fff; background: rgba(139,155,255,.35); box-shadow: 0 0 0 2px rgba(20,20,30,.6), 0 4px 14px rgba(0,0,0,.35); opacity: 0; transition: opacity .15s, transform .12s; }
.cursor.on { opacity: 1; }
.cursor.press { transform: scale(.7); background: rgba(139,155,255,.85); }
.ring { position: absolute; inset: -8px; }
.ring circle { fill: none; stroke: #a78bfa; stroke-width: 3; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; stroke-dasharray: 101; stroke-dashoffset: 101; }
.outline { position: fixed; pointer-events: none; border: 2px solid #8b9bff; border-radius: 6px; box-shadow: 0 0 0 4px rgba(139,155,255,.18); opacity: 0; transition: opacity .12s, left .08s, top .08s, width .08s, height .08s; }
.outline.on { opacity: 1; }
.outline.flash { border-color: #4ade80; box-shadow: 0 0 0 6px rgba(74,222,128,.25); }
.label { position: fixed; pointer-events: none; padding: 3px 8px; border-radius: 6px; background: rgba(20,20,26,.92); color: #f4f4f7; font: 12px system-ui, sans-serif;
  white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity .12s; }
.label.on { opacity: 1; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const CLICKABLE = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const PINCH_ON = 0.26;
const PINCH_OFF = 0.4;
const DWELL_RADIUS = 28;
const PAUSE_HOLD_MS = 1200;
const HEAD_DEADZONE = 0.06;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function findScroller(x: number, y: number): Element {
  let element = document.elementFromPoint(x, y);
  while (element && element !== document.body && element !== document.documentElement) {
    const style = getComputedStyle(element);
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4) return element;
    element = element.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

function describe(element: Element): string {
  const name = element.getAttribute("aria-label") || (element as HTMLInputElement).placeholder || element.textContent?.replace(/\s+/g, " ").trim() || "";
  const kind = element.matches("a[href]") ? "link" : element.matches("button, [role=button]") ? "button" : element.matches("input, textarea, select") ? "field" : element.tagName.toLowerCase();
  return name ? `${name.slice(0, 40)} · ${kind}` : kind;
}

export class CameraController {
  private host = document.createElement("div");
  private shadow: ShadowRoot;
  private frame = document.createElement("iframe");
  private dot = document.createElement("span");
  private mode = document.createElement("span");
  private cursor = document.createElement("div");
  private ringCircle: SVGCircleElement;
  private outline = document.createElement("div");
  private label = document.createElement("div");
  private extensionOrigin = new URL(chrome.runtime.getURL("")).origin;
  private filterX = new OneEuroFilter();
  private filterY = new OneEuroFilter();
  private paused = false;
  private fistSince: number | null = null;
  private fistFired = false;
  private pinching = false;
  private stable = { x: 0, y: 0 };
  private dwellAnchor: { x: number; y: number; since: number } | null = null;
  private dwellFired = false;
  private hovered: Element | null = null;
  private scrollSpeed = 0;
  private headBaseline: number | null = null;
  private headSamples: number[] = [];
  private lastHeadAt = 0;
  private raf = 0;

  constructor(
    private settings: CameraSettings,
    private hooks: CameraHooks,
  ) {
    this.host.setAttribute(OWN_ATTR, "camera");
    this.host.setAttribute("popover", "manual");
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;background:transparent!important;border:0!important;margin:0!important;padding:0!important";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;

    this.frame.allow = "camera; autoplay";
    this.frame.title = "Hand and head tracking";
    this.dot.className = "dot idle";
    this.mode.className = "mode";
    this.mode.textContent = "Starting camera";
    const off = document.createElement("button");
    off.className = "off";
    off.type = "button";
    off.textContent = "Off";
    off.setAttribute("aria-label", "Turn off camera control");
    off.addEventListener("click", () => this.hooks.turnOff());
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.append(this.dot, this.mode, off);
    const pip = document.createElement("div");
    pip.className = "pip";
    pip.setAttribute("role", "region");
    pip.setAttribute("aria-label", "Camera control");
    pip.append(this.frame, bar);

    this.cursor.className = "cursor";
    const ns = "http://www.w3.org/2000/svg";
    const ring = document.createElementNS(ns, "svg");
    ring.setAttribute("class", "ring");
    ring.setAttribute("viewBox", "0 0 38 38");
    this.ringCircle = document.createElementNS(ns, "circle");
    this.ringCircle.setAttribute("cx", "19");
    this.ringCircle.setAttribute("cy", "19");
    this.ringCircle.setAttribute("r", "16");
    ring.append(this.ringCircle);
    this.cursor.append(ring);
    this.outline.className = "outline";
    this.label.className = "label";

    this.shadow.append(style, this.outline, this.label, this.cursor, pip);
  }

  start() {
    document.documentElement.append(this.host);
    try {
      this.host.showPopover();
    } catch {
      // without popover support the fixed host still renders
    }
    addEventListener("message", this.onMessage);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.refreshCamera();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    removeEventListener("message", this.onMessage);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.frame.removeAttribute("src");
    this.host.remove();
  }

  update(settings: CameraSettings) {
    const reload = settings.headScroll !== this.settings.headScroll || settings.handScroll !== this.settings.handScroll || settings.pointer !== this.settings.pointer;
    this.settings = settings;
    if (reload) this.refreshCamera(true);
  }

  private frameUrl() {
    const needHand = this.settings.pointer || this.settings.handScroll;
    return chrome.runtime.getURL(`camera.html?hand=${needHand ? 1 : 0}&head=${this.settings.headScroll ? 1 : 0}`);
  }

  // The camera only runs in the tab the user is looking at.
  private onVisibility = () => this.refreshCamera();

  private refreshCamera(force = false) {
    const visible = document.visibilityState === "visible";
    if (visible && (force || !this.frame.src)) this.frame.src = this.frameUrl();
    if (!visible) this.frame.removeAttribute("src");
    this.scrollSpeed = 0;
    this.hidePointer();
  }

  private onMessage = (event: MessageEvent) => {
    if (event.source !== this.frame.contentWindow || event.origin !== this.extensionOrigin || event.data?.ba !== "camera") return;
    const data = event.data;
    if (data.type === "status") {
      if (data.state === "blocked") this.setMode("Camera blocked", "paused");
      if (data.state === "failed") this.setMode("Tracking failed", "paused");
      if (data.state === "ready") this.setMode("Show your hand", "idle");
      return;
    }
    if (data.type === "frame") this.onFrame(data.t as number, data.hand as HandFrame | null, data.head as HeadFrame | null);
  };

  private setMode(text: string, state: "on" | "paused" | "idle") {
    if (this.mode.textContent !== text) this.mode.textContent = text;
    this.dot.className = `dot${state === "on" ? "" : ` ${state}`}`;
  }

  private onFrame(t: number, hand: HandFrame | null, head: HeadFrame | null) {
    if (hand?.pose === "fist") {
      this.fistSince ??= t;
      if (!this.fistFired && t - this.fistSince > PAUSE_HOLD_MS) {
        this.fistFired = true;
        this.paused = !this.paused;
        this.hooks.notify(this.paused ? "Gestures paused. Hold a fist again to resume." : "Gestures back on.");
      }
    } else {
      this.fistSince = null;
      this.fistFired = false;
    }
    if (this.paused) {
      this.scrollSpeed = 0;
      this.hidePointer();
      return this.setMode("Paused (hold a fist)", "paused");
    }

    let speed = 0;
    let mode = hand ? "Hand seen" : head ? "Watching head" : "Show your hand";

    if (hand && this.settings.handScroll && hand.pose === "open") {
      const y = hand.palm.y;
      if (y < 0.38) speed = -(4 + ((0.38 - y) / 0.38) * 24);
      else if (y > 0.62) speed = 4 + ((y - 0.62) / 0.38) * 24;
      mode = speed ? (speed < 0 ? "Scrolling up" : "Scrolling down") : "Palm: move up or down";
    }

    if (head && this.settings.headScroll) {
      this.lastHeadAt = t;
      if (this.headBaseline === null) {
        this.headSamples.push(head.pitch);
        if (this.headSamples.length >= 25) this.headBaseline = this.headSamples.reduce((a, b) => a + b, 0) / this.headSamples.length;
        mode = "Hold still, calibrating";
      } else if (!speed) {
        const delta = head.pitch - this.headBaseline;
        if (Math.abs(delta) > HEAD_DEADZONE) {
          speed = Math.sign(delta) * (3 + Math.min(1, (Math.abs(delta) - HEAD_DEADZONE) / 0.12) * 18);
          mode = speed < 0 ? "Head up: scrolling up" : "Head down: scrolling down";
        } else if (!hand) mode = "Head: tilt to scroll";
      }
    } else if (this.headBaseline !== null && t - this.lastHeadAt > 2500) {
      this.headBaseline = null;
      this.headSamples = [];
    }
    this.scrollSpeed = speed;

    if (hand && this.settings.pointer && (hand.pose === "point" || hand.pose === "pinch")) {
      this.updatePointer(t, hand);
      mode = this.pinching ? "Click" : "Pointing";
    } else {
      this.hidePointer();
    }
    this.setMode(mode, hand || head ? "on" : "idle");
  }

  private updatePointer(t: number, hand: HandFrame) {
    // A small box in the middle of the camera view maps to the whole screen, so small hand movements reach every corner.
    const nx = clamp((1 - hand.index.x - 0.18) / 0.64);
    const ny = clamp((hand.index.y - 0.15) / 0.55);
    const x = this.filterX.filter(nx * innerWidth, t);
    const y = this.filterY.filter(ny * innerHeight, t);

    const startPinch = hand.pinch < PINCH_ON && !this.pinching;
    if (hand.pinch > PINCH_OFF) this.pinching = false;
    if (!this.pinching && !startPinch) this.stable = { x, y };

    this.cursor.style.translate = `${this.stable.x}px ${this.stable.y}px`;
    this.cursor.classList.add("on");
    this.cursor.classList.toggle("press", this.pinching || startPinch);

    const under = document.elementFromPoint(this.stable.x, this.stable.y);
    const target = under?.closest(CLICKABLE) ?? under;
    this.hover(target && target !== document.documentElement && target !== document.body ? target : null);

    if (startPinch) {
      this.pinching = true;
      this.activate();
      this.dwellAnchor = null;
      return;
    }
    this.updateDwell(t);
  }

  private updateDwell(t: number) {
    const dwellMs = this.settings.dwellMs;
    if (!dwellMs || !this.hovered) return this.setRing(0);
    const { x, y } = this.stable;
    if (!this.dwellAnchor || Math.hypot(x - this.dwellAnchor.x, y - this.dwellAnchor.y) > DWELL_RADIUS) {
      this.dwellAnchor = { x, y, since: t };
      this.dwellFired = false;
      return this.setRing(0);
    }
    if (this.dwellFired) return this.setRing(0);
    const progress = (t - this.dwellAnchor.since) / dwellMs;
    this.setRing(progress);
    if (progress >= 1) {
      this.dwellFired = true;
      this.activate();
    }
  }

  private setRing(progress: number) {
    this.ringCircle.style.strokeDashoffset = String(101 * (1 - Math.min(1, Math.max(0, progress))));
  }

  private hover(target: Element | null) {
    this.hovered = target;
    if (!target) {
      this.outline.classList.remove("on");
      this.label.classList.remove("on");
      return;
    }
    const rect = target.getBoundingClientRect();
    Object.assign(this.outline.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
    this.outline.classList.add("on");
    this.label.textContent = describe(target);
    Object.assign(this.label.style, { left: `${Math.min(innerWidth - 270, Math.max(8, rect.left))}px`, top: `${rect.top > 32 ? rect.top - 28 : rect.bottom + 6}px` });
    this.label.classList.add("on");
  }

  // The user's own click, like a mouse; the agent never clicks on its own.
  private activate() {
    const target = this.hovered;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches("input, textarea, select, [contenteditable='true']")) target.focus();
    target.click();
    this.outline.classList.add("flash");
    setTimeout(() => this.outline.classList.remove("flash"), 300);
  }

  private hidePointer() {
    this.cursor.classList.remove("on", "press");
    this.outline.classList.remove("on");
    this.label.classList.remove("on");
    this.hovered = null;
    this.dwellAnchor = null;
    this.setRing(0);
    this.filterX.reset();
    this.filterY.reset();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.scrollSpeed) return;
    findScroller(innerWidth / 2, innerHeight / 2).scrollBy({ top: this.scrollSpeed, behavior: "instant" });
  };
}
