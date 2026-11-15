import type { BlockCall } from "../../../shared/adaptation.js";
import { applyContentFilter } from "./content-filter.js";
import { contrastInfo, OWN_ATTR, textElements } from "./dom.js";
import { applyDarkMode } from "./dark-mode.js";
import { applyFormFixer } from "./form-fixer.js";

type Undo = () => void;
type Matrix3 = [number, number, number][];

export interface LiveBlock {
  undo: Undo;
  reapply?: (roots: Element[]) => void;
  note?: Promise<string>;
  // True when the block looked and left the page as it was, such as dark mode on an already-dark page.
  noop?: Promise<boolean>;
  matched?: () => number;
}

// Machado et al. 2009 simulation matrices at full severity.
const SIMULATION: Record<"protanopia" | "deuteranopia" | "tritanopia", Matrix3> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const ERROR_SHIFT: Record<keyof typeof SIMULATION, Matrix3> = {
  protanopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  deuteranopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  tritanopia: [[1, 0, 0.7], [0, 1, 0.7], [0, 0, 0]],
};

const multiply = (a: Matrix3, b: Matrix3): Matrix3 =>
  a.map((row) => [0, 1, 2].map((col) => row.reduce((sum, value, k) => sum + value * b[k][col], 0))) as Matrix3;

function daltonizeMatrix(type: keyof typeof SIMULATION): string {
  const identity: Matrix3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const lostInformation = identity.map((row, i) => row.map((value, j) => value - SIMULATION[type][i][j])) as Matrix3;
  const shift = multiply(ERROR_SHIFT[type], lostInformation);
  const corrected = identity.map((row, i) => row.map((value, j) => value + shift[i][j]));
  return [...corrected.map((row) => [...row.map((value) => value.toFixed(4)), 0, 0].join(" ")), "0 0 0 1 0"].join("  ");
}

function addStyle(css: string): Undo {
  const style = document.createElement("style");
  style.setAttribute(OWN_ATTR, "block");
  style.textContent = css;
  document.documentElement.append(style);
  return () => style.remove();
}

function colorblind(block: Extract<BlockCall, { name: "colorblind" }>): LiveBlock {
  const filterId = `ba-cvd-${block.type}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute(OWN_ATTR, "block");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const filter = document.createElementNS(svg.namespaceURI, "filter");
  filter.id = filterId;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const matrix = document.createElementNS(svg.namespaceURI, "feColorMatrix");
  matrix.setAttribute("type", "matrix");
  matrix.setAttribute("values", daltonizeMatrix(block.type));
  filter.append(matrix);
  svg.append(filter);
  document.documentElement.append(svg);

  const targets = block.scope === "page" ? "body" : "img, video, canvas, picture, svg:not([data-ba])";
  const removeStyle = addStyle(`${targets} { filter: url(#${filterId}) !important; }`);
  return {
    undo: () => {
      removeStyle();
      svg.remove();
    },
  };
}

interface ScaledRecord {
  value: string;
  priority: string;
  px: number;
}

// Inline !important beats site CSS, so a later font-size rule has to take those elements back explicitly.
interface FontScaler {
  release(element: HTMLElement): void;
  rescale(elements: readonly HTMLElement[]): void;
}

const fontScalers = new Set<FontScaler>();

export function releaseScaledFont(elements: Iterable<Element>) {
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    for (const scaler of fontScalers) scaler.release(element);
  }
}

export function rescaleFonts(elements: readonly HTMLElement[]) {
  for (const scaler of fontScalers) scaler.rescale(elements);
}

const STATE_PSEUDO = /:(?:hover|focus-visible|focus-within|focus|active|visited)\b/;
const TEXT_PSEUDO = /::?(?:before|after|placeholder|selection|marker|first-line|first-letter)\b/;

function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = selector.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function withoutNot(selector: string): string {
  let out = "";
  for (let index = 0; index < selector.length; index++) {
    if (!selector.startsWith(":not(", index)) {
      out += selector[index];
      continue;
    }
    let depth = 1;
    index += 4;
    while (index + 1 < selector.length && depth > 0) {
      index++;
      if (selector[index] === "(") depth++;
      else if (selector[index] === ")") depth--;
    }
  }
  return out;
}

// Hover and focus rules must not release text scale on every matching element while the pointer is elsewhere.
// :not(:hover) is a resting rule. Commas inside :is() and :not() stay in one selector.
export function restingFontSizeSelector(selector: string): string | null {
  const parts = splitSelectorList(selector).filter((part) => !STATE_PSEUDO.test(withoutNot(part)) && !TEXT_PSEUDO.test(withoutNot(part)));
  return parts.length ? parts.join(", ") : null;
}

const fontSizeSelectors: string[] = [];

export function watchFontSizeSelector(selector: string): () => void {
  fontSizeSelectors.push(selector);
  return () => {
    const index = fontSizeSelectors.lastIndexOf(selector);
    if (index >= 0) fontSizeSelectors.splice(index, 1);
  };
}

export function releaseRuledFonts(roots: ParentNode[]) {
  for (const selector of fontSizeSelectors) {
    const found: HTMLElement[] = [];
    for (const root of roots) {
      try {
        if (root instanceof HTMLElement && root.matches(selector)) found.push(root);
        for (const element of root.querySelectorAll(selector)) {
          if (element instanceof HTMLElement) found.push(element);
        }
      } catch {
        // One bad selector should not stop the others.
      }
    }
    releaseScaledFont(found);
  }
}

function textScale(scale: number): LiveBlock {
  const scaled = new Map<HTMLElement, ScaledRecord>();
  const handedOff = new WeakSet<HTMLElement>();

  const restoreInline = (element: HTMLElement, record: ScaledRecord) => {
    if (record.value) element.style.setProperty("font-size", record.value, record.priority);
    else element.style.removeProperty("font-size");
  };

  const scaleElements = (elements: HTMLElement[]) => {
    const fresh = elements.filter((element) => element.isConnected && !scaled.has(element) && !handedOff.has(element));
    if (!fresh.length) return;

    const scaledAncestors = new Set<HTMLElement>();
    for (const element of fresh) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (scaled.has(parent)) scaledAncestors.add(parent);
      }
    }
    // New nodes may inherit an already-scaled size, so measure them with ancestors temporarily unscaled to avoid scaling twice.
    for (const ancestor of scaledAncestors) restoreInline(ancestor, scaled.get(ancestor)!);
    const sizes = fresh.map((element) => parseFloat(getComputedStyle(element).fontSize));
    for (const ancestor of scaledAncestors) ancestor.style.setProperty("font-size", `${scaled.get(ancestor)!.px}px`, "important");

    fresh.forEach((element, i) => {
      const px = Number((sizes[i] * scale).toFixed(1));
      scaled.set(element, { value: element.style.getPropertyValue("font-size"), priority: element.style.getPropertyPriority("font-size"), px });
      element.style.setProperty("font-size", `${px}px`, "important");
    });
  };

  const scaler: FontScaler = {
    release(element) {
      const record = scaled.get(element);
      if (!record) return;
      restoreInline(element, record);
      scaled.delete(element);
      handedOff.add(element);
    },
    rescale(elements) {
      const back = elements.filter((element) => handedOff.has(element));
      for (const element of back) handedOff.delete(element);
      scaleElements(back);
    },
  };
  fontScalers.add(scaler);
  scaleElements(textElements());
  // A font-size rule that is already on the page keeps those elements, including ones that load later.
  releaseRuledFonts([document]);
  return {
    reapply: (roots) => {
      scaleElements(textElements(1500, roots));
      releaseRuledFonts(roots);
    },
    undo: () => {
      fontScalers.delete(scaler);
      for (const [element, record] of scaled) restoreInline(element, record);
      scaled.clear();
    },
  };
}

function stopMotion(): LiveBlock {
  const pauseMedia = (roots: ParentNode[]) => {
    for (const root of roots) {
      const media = [...root.querySelectorAll<HTMLMediaElement>("video, audio")];
      if (root instanceof HTMLMediaElement) media.push(root);
      for (const element of media) {
        if (!element.paused) element.pause();
        element.autoplay = false;
      }
    }
  };
  const paused = document.getAnimations().filter((animation) => animation.playState === "running");
  paused.forEach((animation) => animation.pause());
  pauseMedia([document]);
  const removeStyle = addStyle("*, *::before, *::after { animation-play-state: paused !important; transition: none !important; scroll-behavior: auto !important; }");
  return {
    reapply: pauseMedia,
    undo: () => {
      removeStyle();
      paused.forEach((animation) => animation.play());
    },
  };
}

function contentFilter(block: Extract<BlockCall, { name: "contentFilter" }>): LiveBlock {
  const handle = applyContentFilter(block, document);
  return { undo: handle.undo, matched: handle.matched };
}

function channelLuminance(r: number, g: number, b: number): number {
  const channel = (piece: number) => {
    const s = piece / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function backgroundLuminance(color: string): number | null {
  const rgb = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return channelLuminance(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!hex) return null;
  const value = Number.parseInt(hex[1], 16);
  if (!Number.isFinite(value)) return null;
  return channelLuminance((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

function contrastFix(minRatio: number): LiveBlock {
  const marked = new Set<HTMLElement>();
  const style = document.createElement("style");
  style.setAttribute(OWN_ATTR, "contrast");
  // Resting text only. Hover, focus and visited keep the site's own colors.
  style.textContent = `[data-ba-contrast="ink"]:not(:hover):not(:focus):not(:visited) { color: #141414 !important; } [data-ba-contrast="paper"]:not(:hover):not(:focus):not(:visited) { color: #f4f4f5 !important; }`;
  document.documentElement.append(style);
  const paint = (elements: HTMLElement[]) => {
    for (const el of elements) {
      if (!el.isConnected || !el.textContent?.trim()) {
        if (marked.delete(el)) el.removeAttribute("data-ba-contrast");
        continue;
      }
      let info: ReturnType<typeof contrastInfo>;
      try {
        info = contrastInfo(el);
      } catch {
        continue;
      }
      if (!Number.isFinite(info.ratio) || info.ratio >= minRatio) {
        if (marked.delete(el)) el.removeAttribute("data-ba-contrast");
        continue;
      }
      const luminance = backgroundLuminance(info.background);
      if (luminance == null) continue;
      const tone = luminance < 0.5 ? "paper" : "ink";
      if (el.getAttribute("data-ba-contrast") !== tone) el.setAttribute("data-ba-contrast", tone);
      marked.add(el);
    }
  };
  paint(textElements(3000));
  return {
    reapply: (roots) => paint(textElements(1500, roots)),
    undo: () => {
      style.remove();
      for (const el of marked) el.removeAttribute("data-ba-contrast");
      marked.clear();
    },
    matched: () => marked.size,
    note: Promise.resolve(marked.size ? `Raised contrast on ${marked.size} pieces of text.` : "No low-contrast text found."),
  };
}

export function applyBlock(block: BlockCall): LiveBlock {
  switch (block.name) {
    case "colorblind":
      return colorblind(block);
    case "textScale":
      return textScale(block.scale);
    case "stopMotion":
      return stopMotion();
    case "darkMode":
      return applyDarkMode();
    case "contentFilter":
      return contentFilter(block);
    case "formFixer":
      return applyFormFixer(block);
    case "contrast":
      return contrastFix(block.minRatio);
  }
}
