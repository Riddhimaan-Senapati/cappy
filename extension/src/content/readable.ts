import { capForSpeech, normalizeSpace } from "../../../shared/speech.js";

const EXCLUDED = [
  "nav",
  "aside",
  "footer",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "form",
  "select",
  "textarea",
  "button",
  "[hidden]",
  "[aria-hidden=true]",
  "[role=navigation]",
  "[role=complementary]",
  "[role=banner]",
  "[role=contentinfo]",
  "[role=search]",
  "[role=dialog]",
  "[aria-modal=true]",
  "[data-ba]",
  "[contenteditable=true]",
].join(", ");

const INLINE = new Set(["A", "SPAN", "B", "STRONG", "EM", "I", "SMALL", "CODE", "ABBR", "SUP", "SUB", "MARK", "U", "TIME", "CITE", "Q", "LABEL", "FONT"]);
const MIN_NAMED_ROOT = 400;

function readable(root: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const element = node as Element;
      if (element.matches(EXCLUDED)) return NodeFilter.FILTER_REJECT;
      if (element instanceof HTMLElement && element.checkVisibility && !element.checkVisibility()) return NodeFilter.FILTER_REJECT;
      if (!INLINE.has(element.tagName)) parts.push("\n");
      return NodeFilter.FILTER_SKIP;
    },
  });
  let node = walker.nextNode();
  while (node) {
    parts.push(node.nodeValue ?? "");
    node = walker.nextNode();
  }
  return normalizeSpace(parts.join(" "));
}

function largestTextBlock(doc: Document): Element | null {
  const scores = new Map<Element, number>();
  for (const block of doc.querySelectorAll("p, pre, blockquote, li, td, dd")) {
    const parent = block.parentElement;
    if (!parent || block.closest(EXCLUDED)) continue;
    const length = normalizeSpace(block.textContent ?? "").length;
    if (length) scores.set(parent, (scores.get(parent) ?? 0) + length);
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const [element, score] of scores) {
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }
  return best;
}

export function extractReadableText(doc: Document = document): string {
  const named = doc.querySelector("main, article, [role=main]");
  if (named) {
    const text = readable(named);
    if (text.length >= MIN_NAMED_ROOT) return capForSpeech(text);
  }
  const block = largestTextBlock(doc);
  return capForSpeech(readable(block ?? doc.body));
}
