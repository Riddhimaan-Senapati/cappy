type Child = Node | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "", children: Child[] = []): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  for (const child of children) if (child) element.append(child);
  return element;
}

type Shape = [tag: "path" | "circle" | "rect", attributes: Record<string, string>];

const ICONS = {
  sparkle: [["path", { d: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" }], ["path", { d: "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" }]],
  settings: [["path", { d: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" }], ["circle", { cx: "16", cy: "6", r: "2" }], ["circle", { cx: "10", cy: "12", r: "2" }], ["circle", { cx: "18", cy: "18", r: "2" }]],
  undo: [["path", { d: "M9 14L4 9l5-5" }], ["path", { d: "M4 9h10a6 6 0 010 12h-3" }]],
  bug: [["path", { d: "M8 9h8v7a4 4 0 01-8 0z" }], ["path", { d: "M12 5v4M5 12h3M16 12h3M6 19l2-2M18 19l-2-2M9 5l1.5 2M15 5l-1.5 2" }]],
  pause: [["rect", { x: "6", y: "5", width: "4", height: "14", rx: "1" }], ["rect", { x: "14", y: "5", width: "4", height: "14", rx: "1" }]],
  play: [["path", { d: "M7 5l12 7-12 7z" }]],
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  shield: [["path", { d: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" }], ["path", { d: "M9 12l2 2 4-4" }]],
  back: [["path", { d: "M19 12H5M11 6l-6 6 6 6" }]],
  bolt: [["path", { d: "M13 3L5 14h6l-1 7 8-11h-6z" }]],
  text: [["path", { d: "M4 7V5h16v2M12 5v14M9 19h6" }]],
  moon: [["path", { d: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" }]],
  eye: [["path", { d: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
  keyboard: [["rect", { x: "3", y: "6", width: "18", height: "12", rx: "2" }], ["path", { d: "M7 10h.01M11 10h.01M15 10h.01M7 14h10" }]],
  circle: [["circle", { cx: "12", cy: "12", r: "8" }]],
  volume: [["path", { d: "M4 9h4l5-4v14l-5-4H4z" }], ["path", { d: "M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11" }]],
  trash: [["path", { d: "M3 6h18M9 6V3h6v3m4 0-1 15H6L5 6m5 4v7m4-7v7" }]],
  mic: [["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }], ["path", { d: "M5 11a7 7 0 0014 0M12 18v3" }]],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): HTMLSpanElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(key, value);
  }
  for (const [tag, attributes] of ICONS[name] as Shape[]) {
    const shape = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  const wrapper = h("span", "ico");
  wrapper.append(svg);
  return wrapper;
}

export function adoptStyles(root: ShadowRoot | Document, css: string) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = css;
    (root instanceof Document ? root.head : root).append(style);
  }
}
