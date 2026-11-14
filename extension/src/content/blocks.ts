import type { BlockCall } from "../../../shared/adaptation.js";
import { applyContentFilter } from "./content-filter.js";
import { OWN_ATTR, textElements } from "./dom.js";
import { applyDarkMode } from "./dark-mode.js";

type Undo = () => void;
type Matrix3 = [number, number, number][];

export interface LiveBlock {
  undo: Undo;
  reapply?: (roots: Element[]) => void;
  note?: Promise<string>;
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

function textScale(scale: number): LiveBlock {
  const scaled = new Map<HTMLElement, ScaledRecord>();

  const restoreInline = (element: HTMLElement, record: ScaledRecord) => {
    if (record.value) element.style.setProperty("font-size", record.value, record.priority);
    else element.style.removeProperty("font-size");
  };

  const scaleElements = (elements: HTMLElement[]) => {
    const fresh = elements.filter((element) => element.isConnected && !scaled.has(element));
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

  scaleElements(textElements());
  return {
    reapply: (roots) => scaleElements(textElements(1500, roots)),
    undo: () => {
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
  const handle = applyContentFilter(block, document, location.hostname);
  return { undo: handle.undo, matched: handle.matched };
}

export function applyBlock(block: BlockCall): LiveBlock {
  switch (block.name) {
    case "colorblind":
      return colorblind(block);
    case "textScale":
      return textScale(block.scale);
    case "stopMotion":
      return stopMotion();
    case "darkMode": {
      const dark = applyDarkMode(block);
      return { undo: dark.undo, note: dark.note };
    }
    case "contentFilter":
      return contentFilter(block);
    case "darkMode":
      throw new Error(`block ${block.name} is not implemented yet`);
  }
}
