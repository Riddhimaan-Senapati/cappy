import type { GestureAction, GestureName } from "../../../shared/validate.js";
import { OWN_ATTR } from "./dom.js";

export interface GestureHooks {
  openSpotlight(): void;
  stop(changeId: string): void;
}

interface Mapping {
  gesture: GestureName;
  action: GestureAction;
}

const PIP_CSS = `
:host { all: initial; }
.pip { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; width: 196px; border-radius: 16px; overflow: hidden; background: #0e0e12;
  border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 40px rgba(0,0,0,.45); font: 12px system-ui, sans-serif; color: #e8e8ee;
  animation: in .35s cubic-bezier(.2,.9,.3,1.15); }
@keyframes in { from { opacity: 0; transform: translateY(12px) scale(.96); } }
iframe { display: block; width: 196px; height: 147px; border: 0; }
.bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 0 rgba(74,222,128,.6); animation: ping 1.8s infinite; }
@keyframes ping { to { box-shadow: 0 0 0 8px rgba(74,222,128,0); } }
.label { flex: 1; }
button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #9a9aa6; }
button:hover { color: #fff; background: rgba(255,255,255,.1); }
button:focus-visible { outline: 2px solid #7c8cff; }
@media (prefers-reduced-motion: reduce) { .pip, .dot { animation: none; } }
`;

const DISCRETE_STEP = 0.42;
const PAGE_STEP = 0.85;

function findScroller(): Element {
  let element = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (element && element !== document.body && element !== document.documentElement) {
    const style = getComputedStyle(element);
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4) return element;
    element = element.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

export function startGestures(mappings: Mapping[], changeId: string, hooks: GestureHooks): () => void {
  const host = document.createElement("div");
  host.setAttribute(OWN_ATTR, "gestures");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${PIP_CSS}</style>
    <div class="pip" role="region" aria-label="Hand gesture camera">
      <iframe allow="camera; autoplay" title="Hand tracking"></iframe>
      <div class="bar"><span class="dot"></span><span class="label">Hand gestures on</span><button type="button" aria-label="Turn off hand gestures">Off</button></div>
    </div>`;
  const frame = shadow.querySelector("iframe")!;
  const extensionOrigin = new URL(chrome.runtime.getURL("")).origin;
  const frameUrl = chrome.runtime.getURL("gesture.html");

  const byGesture = new Map<GestureName, GestureAction>(mappings.map((mapping) => [mapping.gesture, mapping.action]));
  const isScroll = (action: GestureAction | undefined) => action === "scroll_up" || action === "scroll_down";

  let direction = 0;
  let speed = 0;
  let held: GestureName | null = null;
  let scroller: Element | null = null;
  let scrollerAt = 0;
  let raf = 0;

  const scrollTarget = () => {
    if (!scroller || performance.now() - scrollerAt > 1500) {
      scroller = findScroller();
      scrollerAt = performance.now();
    }
    return scroller;
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (direction) scrollTarget().scrollBy({ top: direction * speed, behavior: "instant" });
  };

  const perform = (action: GestureAction) => {
    const target = scrollTarget();
    const view = target === document.scrollingElement ? innerHeight : target.clientHeight;
    switch (action) {
      case "scroll_up":
        return target.scrollBy({ top: -view * DISCRETE_STEP, behavior: "smooth" });
      case "scroll_down":
        return target.scrollBy({ top: view * DISCRETE_STEP, behavior: "smooth" });
      case "page_up":
        return target.scrollBy({ top: -view * PAGE_STEP, behavior: "smooth" });
      case "page_down":
        return target.scrollBy({ top: view * PAGE_STEP, behavior: "smooth" });
      case "scroll_top":
        return target.scrollTo({ top: 0, behavior: "smooth" });
      case "scroll_bottom":
        return target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
      case "go_back":
        return history.back();
      case "go_forward":
        return history.forward();
      case "open_spotlight":
        return hooks.openSpotlight();
    }
  };

  const onFrame = (data: { present: boolean; pose?: string; y?: number }) => {
    let next: GestureName | null = null;
    let intensity = 0;
    if (data.present && data.pose === "open_palm" && typeof data.y === "number") {
      if (data.y < 0.35) {
        next = "hand_high";
        intensity = (0.35 - data.y) / 0.35;
      } else if (data.y > 0.65) {
        next = "hand_low";
        intensity = (data.y - 0.65) / 0.35;
      }
    }
    const action = next ? byGesture.get(next) : undefined;
    direction = 0;
    if (next && isScroll(action)) {
      direction = action === "scroll_up" ? -1 : 1;
      speed = 3 + Math.min(1, intensity * 1.4) * 20;
    } else if (next && action && next !== held) {
      perform(action);
    }
    held = next;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== extensionOrigin || event.data?.ba !== "gesture") return;
    const data = event.data;
    if (data.type === "frame") onFrame(data);
    else if (data.type === "event") {
      const action = byGesture.get(data.name);
      if (action) perform(action);
    }
  };

  const setActive = (active: boolean) => {
    if (active) frame.src = frameUrl;
    else frame.removeAttribute("src");
    direction = 0;
  };
  const onVisibility = () => setActive(document.visibilityState === "visible");

  shadow.querySelector("button")!.addEventListener("click", () => hooks.stop(changeId));
  addEventListener("message", onMessage);
  document.addEventListener("visibilitychange", onVisibility);
  document.documentElement.append(host);
  setActive(document.visibilityState === "visible");
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("message", onMessage);
    document.removeEventListener("visibilitychange", onVisibility);
    host.remove();
  };
}
