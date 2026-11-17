import { parseRgba, relativeLuminance, type Rgba } from "./color.js";

export const OWN_ATTR = "data-ba";

export function isOwn(element: Element): boolean {
  return element.closest(`[${OWN_ATTR}]`) !== null;
}

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && Number(style.opacity) > 0;
}

export function queryAll(selector: string, root: ParentNode = document): Element[] {
  try {
    return [...root.querySelectorAll(selector)].filter((element) => !isOwn(element));
  } catch {
    throw new Error(`Invalid selector: ${selector}`);
  }
}

export function textElements(limit = 4000, roots?: ParentNode[]): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const root of roots ?? (document.body ? [document.body] : [])) {
    if (found.size >= limit) break;
    const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || isOwn(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode() && found.size < limit) found.add(walker.currentNode.parentElement as HTMLElement);
  }
  return [...found];
}

export function queryIn(roots: ParentNode[], selector: string): Element[] {
  const found = new Set<Element>();
  try {
    for (const root of roots) {
      if (root instanceof Element && root.matches(selector)) found.add(root);
      for (const element of root.querySelectorAll(selector)) found.add(element);
    }
  } catch {
    throw new Error(`Invalid selector: ${selector}`);
  }
  return [...found].filter((element) => !isOwn(element));
}

export function cssPath(element: Element): string {
  if (element.id && /^[a-zA-Z][\w-]*$/.test(element.id)) return `#${element.id}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 4) {
    if (current.id && /^[a-zA-Z][\w-]*$/.test(current.id)) {
      parts.unshift(`#${current.id}`);
      break;
    }
    const classes = [...current.classList].filter((name) => /^[a-zA-Z][\w-]*$/.test(name)).slice(0, 2);
    let part = current.tagName.toLowerCase() + classes.map((name) => `.${name}`).join("");
    const siblings = current.parentElement ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current!.tagName) : [];
    if (siblings.length > 1 && !classes.length) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

const SAFE_ID = /^[A-Za-z][\w-]*$/;

// Built without CSS escapes so the model can reuse it in CSS (the safety layer rejects backslashes).
export function uniqueSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    if (current.id && SAFE_ID.test(current.id)) {
      parts.unshift(`#${current.id}`);
      if (document.querySelectorAll(parts.join(" > ")).length === 1) return parts.join(" > ");
      break;
    }
    const parent: Element | null = current.parentElement;
    parts.unshift(parent ? `${current.tagName.toLowerCase()}:nth-child(${[...parent.children].indexOf(current) + 1})` : current.tagName.toLowerCase());
    if (document.querySelectorAll(parts.join(" > ")).length === 1) return parts.join(" > ");
    current = parent;
  }
  return parts.join(" > ");
}

export function describeElement(element: Element): string {
  const name = element.getAttribute("aria-label") || (element as HTMLInputElement).placeholder || element.textContent?.replace(/\s+/g, " ").trim() || "";
  const kind = element.matches("a[href]") ? "link" : element.matches("button, [role=button]") ? "button" : element.matches("input, textarea, select") ? "field" : element.matches("img") ? "image" : element.tagName.toLowerCase();
  return name ? `${name.slice(0, 40)} · ${kind}` : kind;
}

export function accessibleName(element: Element): string {
  const references = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  const referencedText = references.map((id) => {
    const label = element.ownerDocument.getElementById(id);
    return label?.getAttribute("aria-label")?.trim() || label?.textContent?.trim() || "";
  }).join(" ").trim();
  const control = element as HTMLInputElement;
  const fromLabels = Array.from(control.labels ?? [], (label) => label.textContent?.trim()).join(" ").trim();
  return referencedText || element.getAttribute("aria-label")?.trim() || fromLabels || element.getAttribute("title")?.trim() || "";
}

export const LABELLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

export const AD_OR_POPUP =
  '[class*="advert" i], [id*="advert" i], [class~="ad"], [class*="ad-slot" i], [class*="sponsor" i], [aria-label*="advert" i], [data-ad], iframe[src*="doubleclick"], [role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="newsletter" i], [class*="cookie" i]';

function composite(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function effectiveBackground(element: Element): Rgba {
  const layers: Rgba[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const color = parseRgba(getComputedStyle(current).backgroundColor);
    if (!color || color.a === 0) continue;
    layers.push(color);
    if (color.a === 1) break;
  }
  return layers.reduceRight((bottom, top) => composite(top, bottom), { r: 255, g: 255, b: 255, a: 1 });
}

const hex = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export function contrastInfo(element: Element): { ratio: number; color: string; background: string; backgroundLuminance: number } {
  const foreground = parseRgba(getComputedStyle(element).color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const background = effectiveBackground(element);
  // Text alpha is ignored here, as before.
  const foregroundLuminance = relativeLuminance({ ...foreground, a: 1 });
  const backgroundLuminance = relativeLuminance({ r: Math.round(background.r), g: Math.round(background.g), b: Math.round(background.b), a: 1 });
  const [light, dark] = [foregroundLuminance, backgroundLuminance].sort((a, b) => b - a);
  return {
    ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 10) / 10,
    color: hex(foreground),
    background: hex(background),
    backgroundLuminance,
  };
}

export function contrastRatio(element: Element): number {
  return contrastInfo(element).ratio;
}
