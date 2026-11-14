import { SnapshotId, type OutlineElement } from "@browser-agent/shared";

export const SNAPSHOT_MAX = 300;
export const SNAPSHOT_TEXT_MAX = 120;

export type Snapshot = { elements: OutlineElement[]; map: Map<string, Element> };

const MAIN_SELECTOR = "main, [role=main], #content, #primary";
const SKIP_TAGS = new Set(["script", "style", "svg", "noscript", "template", "iframe", "head", "meta", "link"]);
const MEANINGFUL_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "button", "input", "select", "textarea",
  "li", "article", "section", "aside", "nav", "main",
]);

// Ids live in a side Map, not in the DOM, so the page's own markup and scripts never see them.
export function buildSnapshot(doc: Document): Snapshot {
  const elements: OutlineElement[] = [];
  const map = new Map<string, Element>();
  const root = doc.body ?? doc.documentElement;
  const main = doc.querySelector(MAIN_SELECTOR);
  // The main content goes first so the element budget is not spent on masthead and navigation.
  const seen = new Set<Element>();

  const visit = (el: Element): void => {
    if (elements.length >= SNAPSHOT_MAX || seen.has(el)) return;
    seen.add(el);
    if (SKIP_TAGS.has(el.localName) || el.hasAttribute("data-ba")) return;
    const style = doc.defaultView?.getComputedStyle(el);
    if (el.hasAttribute("hidden") || style?.display === "none") return;

    if (style?.visibility !== "hidden" && isMeaningful(el)) {
      const id = SnapshotId.parse(`n${elements.length + 1}`);
      const role = el.getAttribute("role")?.slice(0, 40);
      const entry: OutlineElement = { id, tag: el.localName.slice(0, 20), text: labelOf(el) };
      if (role) entry.role = role;
      elements.push(entry);
      map.set(id, el);
    }
    for (const child of Array.from(el.children)) visit(child);
  };

  if (main) visit(main);
  for (const child of Array.from(root.children)) visit(child);
  return { elements, map };
}

function isMeaningful(el: Element): boolean {
  const tag = el.localName;
  if (MEANINGFUL_TAGS.has(tag)) return true;
  if (tag === "img") return (el.getAttribute("alt") ?? "").trim().length > 0;
  if (el.hasAttribute("role")) return true;
  return hasDirectText(el);
}

function hasDirectText(el: Element): boolean {
  return Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
}

function labelOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  const raw =
    aria ||
    (el.localName === "img" ? el.getAttribute("alt") : null) ||
    (el.localName === "input" || el.localName === "textarea" || el.localName === "select"
      ? (el.getAttribute("placeholder") ?? el.getAttribute("name"))
      : null) ||
    el.textContent ||
    "";
  return raw.replace(/\s+/g, " ").trim().slice(0, SNAPSHOT_TEXT_MAX);
}
