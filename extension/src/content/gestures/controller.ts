import type { HandFrame, HeadFrame } from "../../camera/vision.js";
import type { CameraSettings } from "../../storage.js";
import { describeElement, OWN_ATTR } from "../dom.js";
import { OneEuroFilter } from "./filter.js";

export interface CameraHooks {
  notify(text: string): void;
  turnOff(): void;
  select(element: Element): void;
  cancel(): boolean;
  hasSelection(): boolean;
}

const CSS = `
:host { all: initial; }
.pip { position: fixed; left: 16px; bottom: 16px; width: 228px; border-radius: 14px; overflow: hidden; pointer-events: auto; background: #0e0e12;
  border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 36px rgba(0,0,0,.45); font: 12px system-ui, sans-serif; color: #e8e8ee; animation: in .35s cubic-bezier(.2,.9,.3,1.15); }
@keyframes in { from { opacity: 0; transform: translateY(10px) scale(.96); } }
iframe { display: block; width: 228px; height: 171px; border: 0; }
.bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; flex: none; }
.dot.paused { background: #fbbf24; } .dot.idle { background: rgba(255,255,255,.3); }
.mode { flex: 1; min-width: 0; color: #c9c9d3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.off { all: unset; cursor: pointer; flex: none; padding: 3px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600; color: #e8e8ee; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); }
.off:hover { background: rgba(255,255,255,.14); }
.off.danger { color: #fecaca; background: rgba(239,68,68,.22); border-color: rgba(239,68,68,.45); }
.off.danger:hover { background: rgba(239,68,68,.36); color: #fff; }
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
const TAP_MS = 450;
const SELECT_HOLD_MS = 700;
const STOP_HOLD_MS = 400;
const SWIPE_WINDOW_MS = 450;
const SWIPE_DISTANCE = 0.3;
const SWIPE_COOLDOWN_MS = 1000;
const HEAD_DEADZONE = 0.06;
const HAND_PRIORITY_MS = 800;
const POINTER_GRACE_MS = 300;

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

export class CameraController {
  private host = document.createElement("div");
  private shadow: ShadowRoot;
  private frame = document.createElement("iframe");
  private dot = document.createElement("span");
  private pauseButton = document.createElement("button");
  private offButton = document.createElement("button");
  private overButton: HTMLButtonElement | null = null;
  private mode = document.createElement("span");
  private cursor = document.createElement("div");
  private ringCircle: SVGCircleElement;
  private outline = document.createElement("div");
  private label = document.createElement("div");
  private extensionOrigin = new URL(chrome.runtime.getURL("")).origin;
  private filterX = new OneEuroFilter();
  private filterY = new OneEuroFilter();
  private paused = false;
  private pinching = false;
  private pinchStart = 0;
  private pinchTarget: Element | null = null;
  private holdFired = false;
  private stopSince: number | null = null;
  private stopFired = false;
  private swipeTrail: Array<{ t: number; x: number; y: number }> = [];
  private lastSwipe = 0;
  private stable = { x: 0, y: 0 };
  private dwellAnchor: { x: number; y: number; since: number } | null = null;
  private dwellFired = false;
  private hovered: Element | null = null;
  private scrollSpeed = 0;
  private headBaseline: number | null = null;
  private headSamples: number[] = [];
  private lastHeadAt = 0;
  private lastHandAt = 0;
  private pointerLatched = false;
  private pointerSeenAt = 0;
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
    this.pauseButton.className = "off";
    this.pauseButton.type = "button";
    this.pauseButton.textContent = "Pause";
    this.pauseButton.setAttribute("aria-label", "Pause camera control");
    this.pauseButton.addEventListener("click", () => this.togglePause());
    const off = this.offButton;
    off.className = "off danger";
    off.type = "button";
    off.textContent = "Turn off";
    off.setAttribute("aria-label", "Turn off camera control");
    off.addEventListener("click", () => this.hooks.turnOff());
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.append(this.dot, this.mode, this.pauseButton, off);
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

    this.shadow.append(style, this.outline, this.label, pip, this.cursor);
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
    if (this.paused) {
      this.scrollSpeed = 0;
      this.trackPointer(t, hand);
      return this.setMode("Paused", "paused");
    }

    // Pointing makes people look at the screen, which reads as a head tilt; a recent hand always takes priority.
    if (hand) this.lastHandAt = t;
    const handActive = Boolean(hand) || t - this.lastHandAt < HAND_PRIORITY_MS;
    let speed = 0;
    let mode = handActive ? "Hand seen" : head ? "Watching head" : "Show your hand";

    // A quick, wide, mostly horizontal open-palm swipe goes back or forward, like a trackpad.
    if (hand?.pose === "open" && this.settings.swipeNav !== false) {
      this.swipeTrail = [...this.swipeTrail.filter((sample) => t - sample.t <= SWIPE_WINDOW_MS), { t, x: hand.palm.x, y: hand.palm.y }];
      const first = this.swipeTrail[0];
      const dx = hand.palm.x - first.x;
      const dy = hand.palm.y - first.y;
      if (this.swipeTrail.length >= 4 && t - this.lastSwipe > SWIPE_COOLDOWN_MS && Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dx) > 2.5 * Math.abs(dy)) {
        this.lastSwipe = t;
        this.swipeTrail = [];
        // The camera image is not mirrored: the hand moving toward the image's right is the user swiping to their left.
        const back = dx > 0;
        // With something selected, swiping back clears the selection instead of leaving the page.
        if (back && this.hooks.hasSelection()) {
          this.hooks.cancel();
          this.scrollSpeed = 0;
          return this.setMode("Selection cleared", "on");
        }
        this.hooks.notify(back ? "Back" : "Forward");
        if (back) history.back();
        else history.forward();
        this.scrollSpeed = 0;
        return this.setMode(back ? "Swiped back" : "Swiped forward", "on");
      }
    } else {
      this.swipeTrail = [];
    }

    if (hand && this.settings.handScroll && hand.pose === "open") {
      const y = hand.palm.y;
      if (y < 0.38) speed = -(4 + ((0.38 - y) / 0.38) * 24);
      else if (y > 0.62) speed = 4 + ((y - 0.62) / 0.38) * 24;
      mode = speed ? (speed < 0 ? "Scrolling up" : "Scrolling down") : "Palm: move up or down";
    }

    // Thumbs-down held briefly cancels: a selection in progress, a chosen target or the open bar.
    if (hand?.pose === "thumbs_down") {
      this.stopSince ??= t;
      if (!this.stopFired && t - this.stopSince > STOP_HOLD_MS) {
        this.stopFired = true;
        this.pinching = false;
        this.pinchTarget = null;
        mode = this.hooks.cancel() ? "Cancelled" : "Nothing to cancel";
      } else if (!this.stopFired) mode = "Thumbs down: cancelling";
    } else {
      this.stopSince = null;
      this.stopFired = false;
    }

    if (head && this.settings.headScroll && !handActive) {
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
    } else if (!handActive && this.headBaseline !== null && t - this.lastHeadAt > 2500) {
      this.headBaseline = null;
      this.headSamples = [];
    }
    this.scrollSpeed = speed;

    if (this.trackPointer(t, hand)) mode = this.pinching ? "Click" : "Pointing";
    this.setMode(mode, hand || head ? "on" : "idle");
  }

  // Sticky pointer: once pointing, stay pointing while the index is out, and ride out brief tracking dropouts.
  private trackPointer(t: number, hand: HandFrame | null): boolean {
    const pointing = Boolean(hand) && this.settings.pointer && (hand!.pose === "point" || hand!.pose === "pinch" || (this.pointerLatched && hand!.indexOut && hand!.pose !== "open"));
    if (pointing) {
      this.pointerLatched = true;
      this.pointerSeenAt = t;
      this.updatePointer(t, hand!);
      return true;
    }
    if (this.pointerLatched && t - this.pointerSeenAt < POINTER_GRACE_MS) return true;
    this.pointerLatched = false;
    this.hidePointer();
    return false;
  }

  private updatePointer(t: number, hand: HandFrame) {
    // A small box in the middle of the camera view maps to the whole screen, so small hand movements reach every corner.
    // Kept well inside the camera view: near the frame border tracking drops out, so screen edges must be reachable from the middle.
    const nx = clamp((1 - hand.index.x - 0.27) / 0.46);
    const ny = clamp((hand.index.y - 0.2) / 0.42);
    const x = this.filterX.filter(nx * innerWidth, t);
    const y = this.filterY.filter(ny * innerHeight, t);

    const startPinch = hand.pinch < PINCH_ON && !this.pinching;
    if (this.pinching && hand.pinch > PINCH_OFF) this.endPinch(t);
    if (!this.pinching && !startPinch) this.stable = { x, y };

    this.cursor.style.translate = `${this.stable.x}px ${this.stable.y}px`;
    this.cursor.classList.add("on");
    this.cursor.classList.toggle("press", this.pinching || startPinch);

    const inside = (button: HTMLElement) => {
      const rect = button.getBoundingClientRect();
      return this.stable.x >= rect.left - 4 && this.stable.x <= rect.right + 4 && this.stable.y >= rect.top - 4 && this.stable.y <= rect.bottom + 4;
    };
    this.overButton = [this.pauseButton, this.offButton].find(inside) ?? null;
    if (this.overButton) this.hover(this.overButton);
    else if (this.paused) this.hover(null);
    else {
      const under = document.elementFromPoint(this.stable.x, this.stable.y);
      const target = under?.closest(CLICKABLE) ?? under;
      this.hover(target && target !== document.documentElement && target !== document.body && target !== this.host ? target : null);
    }

    if (startPinch) {
      this.pinching = true;
      this.pinchStart = t;
      this.pinchTarget = this.hovered;
      this.holdFired = false;
      this.dwellAnchor = null;
    }
    if (this.pinching) {
      // A quick pinch clicks; holding the pinch selects the element as the agent's target.
      const held = t - this.pinchStart;
      this.setRing(held > 200 ? (held - 200) / (SELECT_HOLD_MS - 200) : 0);
      if (!this.holdFired && held >= SELECT_HOLD_MS && this.pinchTarget && !this.isPreviewButton(this.pinchTarget) && !this.paused) {
        this.holdFired = true;
        this.setRing(0);
        this.hooks.select(this.pinchTarget);
      }
      return;
    }
    this.updateDwell(t);
  }

  private endPinch(t: number) {
    this.pinching = false;
    if (this.isPreviewButton(this.pinchTarget)) this.pressPreviewButton(this.pinchTarget as HTMLButtonElement);
    else if (!this.holdFired && t - this.pinchStart < TAP_MS && this.pinchTarget && !this.paused) {
      this.hovered = this.pinchTarget;
      this.activate();
    }
    this.pinchTarget = null;
    this.setRing(0);
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
    this.label.textContent =
      target === this.pauseButton ? `${this.paused ? "Resume" : "Pause"} · camera control` : target === this.offButton ? "Turn off · camera control" : describeElement(target);
    Object.assign(this.label.style, { left: `${Math.min(innerWidth - 270, Math.max(8, rect.left))}px`, top: `${rect.top > 32 ? rect.top - 28 : rect.bottom + 6}px` });
    this.label.classList.add("on");
  }

  // The user's own click, like a mouse; the agent never clicks on its own.
  private togglePause() {
    this.paused = !this.paused;
    this.scrollSpeed = 0;
    this.pauseButton.textContent = this.paused ? "Resume" : "Pause";
    this.pauseButton.setAttribute("aria-label", this.paused ? "Resume camera control" : "Pause camera control");
    this.hooks.notify(this.paused ? "Camera control paused. Point at Resume and pinch to continue." : "Camera control resumed.");
  }

  private isPreviewButton(element: Element | null) {
    return element === this.pauseButton || element === this.offButton;
  }

  private pressPreviewButton(button: HTMLButtonElement) {
    if (button === this.pauseButton) this.togglePause();
    else this.hooks.turnOff();
  }

  private activate() {
    if (this.overButton) return this.pressPreviewButton(this.overButton);
    const target = this.hovered;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches("input, textarea, select, [contenteditable='true']")) target.focus();
    target.click();
    this.outline.classList.add("flash");
    setTimeout(() => this.outline.classList.remove("flash"), 300);
  }

  private hidePointer() {
    this.pinching = false;
    this.pinchTarget = null;
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
