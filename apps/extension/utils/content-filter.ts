import type { ContentFilter } from "@browser-agent/shared";

export const FILTER_DEBOUNCE_MS = 150;
export const DIM_OPACITY = "0.25";

export type ContentFilterHandle = (() => void) & { readonly matched: number };

type Touch = { style: string | null; action: ContentFilter["action"] };

// Hides or dims items whose text matches a keyword. Infinite scroll adds items after the first pass,
// so a debounced observer re-runs the filters over the page. Undo restores each element's style
// attribute exactly as it was before the first filter touched it.
export function applyContentFilters(filters: readonly ContentFilter[], doc: Document): ContentFilterHandle {
  const touched = new Map<HTMLElement, Touch>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let undone = false;

  const matchers = filters.map((filter) => ({
    filter,
    pattern: keywordPattern(filter.keywords),
  }));

  const pass = (): void => {
    if (undone) return;
    const desired = new Map<HTMLElement, ContentFilter["action"]>();
    for (const { filter, pattern } of matchers) {
      for (const el of queryItems(doc, filter.itemSelector)) {
        if (desired.has(el)) continue;
        if (pattern.test(searchableText(el))) desired.set(el, filter.action);
      }
    }

    for (const [el, touch] of touched) {
      if (!desired.has(el)) {
        restore(el, touch.style);
        touched.delete(el);
      }
    }
    for (const [el, action] of desired) {
      if (touched.has(el)) continue;
      touched.set(el, { style: el.getAttribute("style"), action });
      apply(el, action);
    }
  };

  const observer = new MutationObserver(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      pass();
    }, FILTER_DEBOUNCE_MS);
  });

  pass();
  if (doc.body) observer.observe(doc.body, { childList: true, subtree: true, characterData: true });

  const undo = (): void => {
    if (undone) return;
    undone = true;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const [el, touch] of touched) restore(el, touch.style);
    touched.clear();
  };

  const handle = undo as ContentFilterHandle;
  Object.defineProperty(handle, "matched", { get: () => touched.size });
  return handle;
}

function queryItems(doc: Document, selector: string): HTMLElement[] {
  try {
    return Array.from(doc.querySelectorAll(selector)).filter((el): el is HTMLElement => el instanceof HTMLElement);
  } catch {
    return [];
  }
}

function apply(el: HTMLElement, action: ContentFilter["action"]): void {
  if (action === "hide") {
    el.style.setProperty("display", "none", "important");
    return;
  }
  el.style.setProperty("opacity", DIM_OPACITY, "important");
  el.style.setProperty("filter", "grayscale(1)", "important");
}

function restore(el: HTMLElement, style: string | null): void {
  if (style === null) el.removeAttribute("style");
  else el.setAttribute("style", style);
}

// Keywords match as whole words, with an optional plural ending ("podcast" also matches "podcasts").
export function keywordPattern(keywords: readonly string[]): RegExp {
  const alternatives = keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .map((k) => `(?<![a-z0-9])${escapeRegExp(k)}(?:e?s)?(?![a-z0-9])`);
  // An empty alternation would match everything, so a filter with no usable keyword matches nothing.
  if (alternatives.length === 0) return /(?!)/;
  return new RegExp(alternatives.join("|"), "i");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchableText(el: HTMLElement): string {
  const parts: string[] = [el.textContent ?? ""];
  const aria = el.getAttribute("aria-label");
  if (aria) parts.push(aria);
  const own = el.getAttribute("title");
  if (own) parts.push(own);
  for (const node of Array.from(el.querySelectorAll("[title], a[href]"))) {
    const title = node.getAttribute("title");
    if (title) parts.push(title);
    const href = node.localName === "a" ? node.getAttribute("href") : null;
    if (href) parts.push(href);
  }
  return parts.join(" ").replace(/\s+/g, " ").toLowerCase();
}
