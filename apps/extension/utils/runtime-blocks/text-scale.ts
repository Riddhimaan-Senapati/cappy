import type { BlockOf } from "@browser-agent/shared";
import { Journal } from "./journal";

const MAX_ELEMENTS = 3000;
const SKIP = "script, style, noscript, template, svg, [data-ba], [data-ba-cvd]";
const TEXT_NODE = 3;

type Target = { el: HTMLElement; fontSize: number; lineHeight?: number };

// Scales the real computed px sizes. Root font-size percentages do nothing on sites that set px everywhere.
export function applyTextScale(cfg: BlockOf<"text_scale">, doc: Document = document): () => void {
  if (cfg.scale === 1) return () => undefined;
  const win = doc.defaultView ?? window;
  const journal = new Journal();
  try {
    for (const { el, fontSize, lineHeight } of measure(doc, win)) {
      journal.touch(el);
      el.style.setProperty("font-size", px(fontSize * cfg.scale), "important");
      if (lineHeight !== undefined) el.style.setProperty("line-height", px(lineHeight * cfg.scale), "important");
    }
  } catch (err) {
    journal.unwind();
    throw err;
  }
  return () => journal.unwind();
}

// All reads happen before any write, so a parent's new size cannot leak into a child's computed size.
function measure(doc: Document, win: Window): Target[] {
  const targets: Target[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll<HTMLElement>("*") ?? [])) {
    if (targets.length >= MAX_ELEMENTS) break;
    if (!hasOwnText(el) || el.closest(SKIP) || !isShown(el, win)) continue;
    const style = win.getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize);
    if (!(fontSize > 0)) continue;
    const lineHeight = style.lineHeight.endsWith("px") ? parseFloat(style.lineHeight) : undefined;
    targets.push({ el, fontSize, lineHeight });
  }
  return targets;
}

function hasOwnText(el: Element): boolean {
  return Array.from(el.childNodes).some((node) => node.nodeType === TEXT_NODE && (node.textContent ?? "").trim() !== "");
}

function isShown(el: HTMLElement, win: Window): boolean {
  const style = win.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && el.checkVisibility?.() !== false;
}

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}
