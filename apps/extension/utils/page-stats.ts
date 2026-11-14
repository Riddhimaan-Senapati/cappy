import type { PageStats } from "@browser-agent/shared";

// Caps keep one scan cheap on large pages; a capped count is a floor, which is fine for before/after deltas.
const MAX_SCAN = 2000;
const TARGET_PX = 24;
const SMALL_TEXT_PX = 12;
const MIN_CONTRAST = 4.5;

const TARGETS = 'a[href], button, input:not([type="hidden"]), [role="button"]';
const LABELLABLE = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea";
const AD_OR_POPUP = '[class*="ad-"], [id*="ad-"], [class*="popup"], [class*="modal"][open], [role="dialog"], iframe[src*="ads"]';

export type RGBA = { r: number; g: number; b: number; a: number };

export function computePageStats(doc: Document = document): PageStats {
  const win = doc.defaultView;
  if (!win || !doc.body) return emptyStats();
  const style = (el: Element) => win.getComputedStyle(el);

  const texts = take(doc.body.getElementsByTagName("*"), MAX_SCAN).filter(
    (el) => hasOwnText(el) && isVisible(el) && !isOwn(el),
  );

  return {
    inputsWithoutLabel: scan(doc, LABELLABLE).filter((el) => isVisible(el) && !hasAccessibleName(el)).length,
    smallTargets: scan(doc, TARGETS).filter((el) => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width < TARGET_PX || rect.height < TARGET_PX;
    }).length,
    smallText: texts.filter((el) => parseFloat(style(el).fontSize) < SMALL_TEXT_PX).length,
    lowContrastText: texts.filter((el) => {
      const fg = parseColor(style(el).color);
      if (!fg) return false;
      const bg = effectiveBackground(el, win);
      return contrastRatio(over(fg, bg), bg) < MIN_CONTRAST;
    }).length,
    imagesWithoutAlt: scan(doc, "img:not([alt])").filter(isVisible).length,
    runningAnimations: runningAnimations(doc),
    visibleAdsOrPopups: scan(doc, AD_OR_POPUP).filter(isVisible).length,
  };
}

function emptyStats(): PageStats {
  return {
    inputsWithoutLabel: 0,
    smallTargets: 0,
    smallText: 0,
    lowContrastText: 0,
    imagesWithoutAlt: 0,
    runningAnimations: 0,
    visibleAdsOrPopups: 0,
  };
}

function take<T>(items: Iterable<T>, limit: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    out.push(item);
  }
  return out;
}

function scan(root: Document, selector: string): Element[] {
  return take(root.querySelectorAll(selector), MAX_SCAN).filter((el) => !isOwn(el));
}

function runningAnimations(doc: Document): number {
  // Not every DOM implementation (happy-dom, older engines) has getAnimations.
  const running = typeof doc.getAnimations === "function" ? doc.getAnimations() : [];
  const animations = running.filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return animation.playState === "running" && !(target instanceof Element && isOwn(target));
  }).length;
  const media = take(doc.querySelectorAll<HTMLMediaElement>("video, audio"), MAX_SCAN).filter(
    (el) => !el.paused && !isOwn(el),
  ).length;
  return animations + media;
}

// Our own UI is marked data-ba; shadow-root content is never returned by document queries.
export function isOwn(el: Element): boolean {
  return el.closest("[data-ba]") !== null || el.getRootNode() !== el.ownerDocument;
}

function isVisible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  return el.ownerDocument.defaultView?.getComputedStyle(el).visibility !== "hidden";
}

function hasOwnText(el: Element): boolean {
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && (node.textContent ?? "").trim().length > 0) return true;
  }
  return false;
}

const nonEmpty = (value: string | null | undefined): boolean => (value ?? "").trim().length > 0;

// Mirrors what a screen reader would announce as the control's name, without computing the full accname algorithm.
export function hasAccessibleName(el: Element): boolean {
  if (nonEmpty(el.getAttribute("aria-label"))) return true;
  if (nonEmpty(el.getAttribute("aria-labelledby"))) return true;
  if (nonEmpty(el.getAttribute("title"))) return true;
  const labels = (el as HTMLInputElement).labels;
  if (labels) return Array.from(labels).some((label) => nonEmpty(label.textContent));
  return el.closest("label") !== null;
}

// Computed colors are rgb()/rgba() in Chrome. Anything else (color(), oklch()) is skipped rather than guessed.
export function parseColor(value: string): RGBA | undefined {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const match = /^rgba?\((.+)\)$/.exec(text);
  if (!match) return undefined;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const channel = (token: string) => (token.endsWith("%") ? (parseFloat(token) * 255) / 100 : parseFloat(token));
  const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number];
  if ([r, g, b].some((n) => Number.isNaN(n))) return undefined;
  const alphaToken = parts[3];
  const a = alphaToken === undefined ? 1 : alphaToken.endsWith("%") ? parseFloat(alphaToken) / 100 : parseFloat(alphaToken);
  if (Number.isNaN(a)) return undefined;
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

// Source-over compositing of a translucent color onto an opaque one.
export function over(top: RGBA, bottom: RGBA): RGBA {
  const inv = 1 - top.a;
  return {
    r: top.r * top.a + bottom.r * inv,
    g: top.g * top.a + bottom.g * inv,
    b: top.b * top.a + bottom.b * inv,
    a: 1,
  };
}

// The first opaque ancestor background wins; translucent layers are composited over a white page.
export function effectiveBackground(el: Element, win: Window): RGBA {
  const layers: RGBA[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const color = parseColor(win.getComputedStyle(node).backgroundColor);
    if (color && color.a > 0) {
      layers.push(color);
      if (color.a >= 1) break;
    }
  }
  let bg: RGBA = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i]!, bg);
  return bg;
}

function luminance({ r, g, b }: RGBA): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG 2.x contrast ratio, from 1 to 21. Both colors must be opaque.
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const STAT_LABELS: Record<keyof PageStats, string> = {
  inputsWithoutLabel: "Unlabeled inputs",
  smallTargets: "Small targets",
  smallText: "Small text",
  lowContrastText: "Low-contrast text",
  imagesWithoutAlt: "Images without alt",
  runningAnimations: "Running animations",
  visibleAdsOrPopups: "Ads or popups",
};

export function problemTotal(stats: PageStats): number {
  return (Object.keys(STAT_LABELS) as (keyof PageStats)[]).reduce((sum, key) => sum + stats[key], 0);
}

export type StatChange = { label: string; before: number; after: number };

export function statChanges(before: PageStats, after: PageStats): StatChange[] {
  return (Object.keys(STAT_LABELS) as (keyof PageStats)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ label: STAT_LABELS[key], before: before[key], after: after[key] }));
}
