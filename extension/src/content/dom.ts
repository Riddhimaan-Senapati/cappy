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

export function accessibleName(element: Element): string {
  const control = element as HTMLInputElement;
  const fromLabels = control.labels ? [...control.labels].map((label) => label.textContent?.trim()).join(" ") : "";
  return (fromLabels || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.getAttribute("title") || "").trim();
}

export const LABELLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

export const AD_OR_POPUP =
  '[class*="advert" i], [id*="advert" i], [class~="ad"], [class*="ad-slot" i], [class*="sponsor" i], [aria-label*="advert" i], [data-ad], iframe[src*="doubleclick"], [role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="newsletter" i], [class*="cookie" i]';

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const [r, g, b, a = "1"] = match[1].split(/[ ,/]+/).filter(Boolean);
  return [Number(r), Number(g), Number(b), Number(a)];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function effectiveBackground(element: Element | null): Rgba {
  while (element) {
    const color = parseColor(getComputedStyle(element).backgroundColor);
    if (color && color[3] > 0.5) return color;
    element = element.parentElement;
  }
  return [255, 255, 255, 1];
}

export function contrastRatio(element: Element): number {
  const foreground = parseColor(getComputedStyle(element).color) ?? [0, 0, 0, 1];
  const [light, dark] = [luminance(foreground), luminance(effectiveBackground(element))].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
