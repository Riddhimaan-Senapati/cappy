import type { FrictionKind } from "../../../shared/protocol.js";

const INTERACTIVE = 'a, button, input, select, textarea, summary, label, [role=button], [role=link], [onclick], [tabindex]:not([tabindex="-1"])';
const OWN_ATTR = "data-ba";
const ZOOM_IN_AT = 1.15;
const ZOOM_RESET_AT = 1.05;
const RAGE_WINDOW_MS = 700;
const RAGE_RADIUS_PX = 30;
const RAGE_PRESSES = 3;
const MISS_OFFSET_PX = 12;
const MISS_SMALL_PX = 32;
const MISS_DEBOUNCE_MS = 1000;
const MISS_OFFSETS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

function isOwnUi(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof Element && node.hasAttribute(OWN_ATTR));
}

export function startSensors(report: (kind: FrictionKind) => void): () => void {
  const cleanups: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void, options: AddEventListenerOptions) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  const viewport = window.visualViewport;
  if (viewport) {
    let zoomed = false;
    listen(
      viewport,
      "resize",
      (event) => {
        if (!event.isTrusted) return;
        const scale = viewport.scale;
        if (scale <= ZOOM_RESET_AT) zoomed = false;
        else if (!zoomed && scale > ZOOM_IN_AT) {
          zoomed = true;
          report("pinch-zoom");
        }
      },
      { passive: true },
    );
  }

  let presses: { x: number; y: number; at: number }[] = [];
  listen(
    window,
    "pointerdown",
    (event) => {
      const pointer = event as PointerEvent;
      if (!pointer.isTrusted || isOwnUi(pointer)) return;
      const now = Date.now();
      presses = [...presses.filter((press) => now - press.at <= RAGE_WINDOW_MS), { x: pointer.clientX, y: pointer.clientY, at: now }].slice(-5);
      const recent = presses.slice(-RAGE_PRESSES);
      if (recent.length < RAGE_PRESSES) return;
      const [first] = recent;
      const clustered = recent.every((press) => Math.hypot(press.x - first.x, press.y - first.y) <= RAGE_RADIUS_PX);
      if (!clustered) return;
      presses = [];
      report("rage-click");
    },
    { capture: true, passive: true },
  );

  let lastMissed = 0;
  listen(
    window,
    "pointerdown",
    (event) => {
      const pointer = event as PointerEvent;
      if (!pointer.isTrusted || isOwnUi(pointer)) return;
      const target = pointer.target;
      if (!(target instanceof Element) || target.closest(INTERACTIVE)) return;
      const now = Date.now();
      if (now - lastMissed < MISS_DEBOUNCE_MS) return;
      const missed = MISS_OFFSETS.some(([dx, dy]) => {
        const hit = document.elementFromPoint(pointer.clientX + dx * MISS_OFFSET_PX, pointer.clientY + dy * MISS_OFFSET_PX)?.closest(INTERACTIVE);
        if (!hit) return false;
        const box = hit.getBoundingClientRect();
        return box.width < MISS_SMALL_PX || box.height < MISS_SMALL_PX;
      });
      if (!missed) return;
      lastMissed = now;
      report("missed-click");
    },
    { capture: true, passive: true },
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
