import type { BlockCall } from "../../../shared/adaptation.js";
import { isOwn } from "./dom.js";
import { detectItemGroups } from "./item-groups.js";

type Filter = Extract<BlockCall, { name: "contentFilter" }>;
type Action = Filter["action"];

export interface ContentFilterHandle {
  undo: () => void;
  matched: () => number;
}

export const FILTER_DEBOUNCE_MS = 150;
export const GROUP_REFRESH_MS = 1_000;
export const DIM_OPACITY = "0.25";

// Several changes can hide the same item. The element's original style comes back only when its last holder lets go.
type Claim = { original: string | null; holders: Map<object, Action> };
const claims = new Map<HTMLElement, Claim>();

function claim(el: HTMLElement, holder: object, action: Action): void {
  let entry = claims.get(el);
  if (!entry) {
    entry = { original: el.getAttribute("style"), holders: new Map() };
    claims.set(el, entry);
  }
  entry.holders.set(holder, action);
  apply(el, action);
}

function release(el: HTMLElement, holder: object): void {
  const entry = claims.get(el);
  if (!entry) return;
  entry.holders.delete(holder);
  restoreStyle(el, entry.original);
  if (entry.holders.size === 0) {
    claims.delete(el);
    return;
  }
  for (const action of entry.holders.values()) apply(el, action);
}

export function applyContentFilter(filter: Filter, doc: Document, host: string): ContentFilterHandle {
  const holder = {};
  const held = new Map<HTMLElement, Action>();
  const groupSelectors = new Set<string>();
  const pattern = keywordPattern(filter.keywords);
  let groupsAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let undone = false;

  // Groups seen once stay in the set: a group whose items are all hidden no longer looks like a group, and would otherwise be un-hidden.
  const selectorsToCheck = (): string[] => {
    if (filter.itemSelector) return [filter.itemSelector];
    const now = Date.now();
    if (now - groupsAt >= GROUP_REFRESH_MS) {
      groupsAt = now;
      for (const group of detectItemGroups(doc, host)) groupSelectors.add(group.selector);
    }
    return [...groupSelectors];
  };

  const pass = (): void => {
    if (undone) return;
    const desired = new Map<HTMLElement, Action>();
    for (const el of targets(doc, selectorsToCheck(), pattern)) desired.set(el, filter.action);

    for (const el of Array.from(held.keys())) {
      if (desired.has(el)) continue;
      release(el, holder);
      held.delete(el);
    }
    for (const [el, action] of desired) {
      if (held.has(el)) continue;
      claim(el, holder, action);
      held.set(el, action);
    }
  };

  // Infinite scroll can mutate the page faster than the delay, so one pass is scheduled per window rather than pushed back by every mutation.
  const schedulePass = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      pass();
    }, FILTER_DEBOUNCE_MS);
  };

  pass();
  const observer = new MutationObserver(schedulePass);
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true, characterData: true });

  const undo = (): void => {
    if (undone) return;
    undone = true;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const el of held.keys()) release(el, holder);
    held.clear();
  };

  return { undo, matched: () => held.size };
}

// A keyword hit on an item also matches every container around it, since text is inherited, so a
// selector like "div" would hide the whole page. Containers holding unmatched members of the same
// selector are skipped, and only the outermost hit is hidden, so a card goes as one unit.
function targets(doc: Document, selectors: readonly string[], pattern: RegExp): HTMLElement[] {
  const hits: HTMLElement[] = [];
  const missesAbove = new Map<HTMLElement, Set<string>>();
  const hitsAbove = new Map<HTMLElement, Set<string>>();
  for (const selector of selectors) {
    for (const el of queryItems(doc, selector)) {
      const matched = pattern.test(searchableText(el));
      if (matched) hits.push(el);
      const table = matched ? hitsAbove : missesAbove;
      for (let a = el.parentElement; a; a = a.parentElement) {
        let set = table.get(a);
        if (!set) {
          set = new Set();
          table.set(a, set);
        }
        set.add(selector);
      }
    }
  }

  const candidates = new Set<HTMLElement>();
  for (const el of hits) {
    const misses = missesAbove.get(el);
    const contained = hitsAbove.get(el);
    const mixed = misses !== undefined && contained !== undefined && [...misses].some((s) => contained.has(s));
    if (!mixed) candidates.add(el);
  }
  return [...candidates].filter((el) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (candidates.has(a)) return false;
    return true;
  });
}

function queryItems(doc: Document, selector: string): HTMLElement[] {
  try {
    return Array.from(doc.querySelectorAll(selector)).filter((el): el is HTMLElement => el instanceof HTMLElement && !isOwn(el));
  } catch {
    return [];
  }
}

function apply(el: HTMLElement, action: Action): void {
  if (action === "hide") {
    el.style.setProperty("display", "none", "important");
    return;
  }
  el.style.setProperty("opacity", DIM_OPACITY, "important");
  el.style.setProperty("filter", "grayscale(1)", "important");
}

function restoreStyle(el: HTMLElement, style: string | null): void {
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
  // textContent alone glues adjacent elements together ("roundupPodcast"), so element edges get a space.
  const parts: string[] = [spacedText(el)];
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

function spacedText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += child.nodeValue ?? "";
    else if (child.nodeType === 1) out += ` ${spacedText(child)} `;
  }
  return out;
}
