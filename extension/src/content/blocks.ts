import type { BlockCall } from "../../../shared/adaptation.js";
import { OWN_ATTR, textElements } from "./dom.js";

type Undo = () => void;
type Matrix3 = [number, number, number][];

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

function colorblind(block: Extract<BlockCall, { name: "colorblind" }>): Undo {
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
  return () => {
    removeStyle();
    svg.remove();
  };
}

function textScale(scale: number): Undo {
  const elements = textElements();
  const sizes = elements.map((element) => parseFloat(getComputedStyle(element).fontSize));
  const previous = elements.map((element) => [element.style.getPropertyValue("font-size"), element.style.getPropertyPriority("font-size")]);
  elements.forEach((element, i) => element.style.setProperty("font-size", `${(sizes[i] * scale).toFixed(1)}px`, "important"));
  return () =>
    elements.forEach((element, i) => {
      const [value, priority] = previous[i];
      if (value) element.style.setProperty("font-size", value, priority);
      else element.style.removeProperty("font-size");
    });
}

function stopMotion(): Undo {
  const paused = document.getAnimations().filter((animation) => animation.playState === "running");
  paused.forEach((animation) => animation.pause());
  document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => {
    if (!media.paused) media.pause();
    media.autoplay = false;
  });
  const removeStyle = addStyle(
    "*, *::before, *::after { animation-play-state: paused !important; transition: none !important; scroll-behavior: auto !important; }",
  );
  return () => {
    removeStyle();
    paused.forEach((animation) => animation.play());
  };
}

export function applyBlock(block: BlockCall): Undo {
  switch (block.name) {
    case "colorblind":
      return colorblind(block);
    case "textScale":
      return textScale(block.scale);
    case "stopMotion":
      return stopMotion();
  }
}
