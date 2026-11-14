import { isScheduleActive, type ContentFilter } from "@browser-agent/shared";
import { now as clockNow } from "./clock";
import { findItemGroups } from "./item-groups";

export const FILTER_DEBOUNCE_MS = 150;
export const SCHEDULE_TICK_MS = 30_000;
export const DIM_OPACITY = "0.25";

type Action = ContentFilter["action"];
export type ContentFilterHandle = (() => void) & { readonly matched: number; refresh: () => void };

// Every filter that hides or dims an element holds a claim on it. The element's original style is
// restored only when the last claim is released, so two filters (or a rule and a one-off change)
// can touch the same item without one undo un-hiding the other's items.
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
  restore(el, entry.original);
  if (entry.holders.size === 0) {
    claims.delete(el);
    return;
  }
  for (const action of entry.holders.values()) apply(el, action);
}

// Filters with an itemSelector act on that selector. Filters without one act on every repeated
// item group found on the page. Groups seen once stay in the set, because a group whose items are
// all hidden no longer qualifies as a group and would otherwise be un-hidden by the next pass.
// Each filter applies only while its schedule is active, re-checked on every pass.
export function applyContentFilters(
  filters: readonly ContentFilter[],
  doc: Document,
  clock: () => Date = clockNow,
): ContentFilterHandle {
  const holder = {};
  const held = new Map<HTMLElement, Action>();
  const groupSelectors = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let undone = false;

  const matchers = filters.map((filter) => ({
    filter,
    pattern: keywordPattern(filter.keywords),
    everyGroup: !filter.itemSelector,
  }));
  const needsGroups = matchers.some((m) => m.everyGroup);

  const pass = (): void => {
    if (undone) return;
    if (needsGroups) for (const group of findItemGroups(doc)) groupSelectors.add(group.selector);
    const at = clock();
    const desired = new Map<HTMLElement, Action>();
    for (const { filter, pattern, everyGroup } of matchers) {
      if (!isScheduleActive(filter.schedule, at)) continue;
      const selectors = everyGroup ? [...groupSelectors] : [filter.itemSelector!];
      for (const el of groupTargets(doc, selectors, pattern)) {
        if (!desired.has(el)) desired.set(el, filter.action);
      }
    }

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

  // Infinite scroll can mutate the page faster than the delay, so a pass is scheduled once per
  // window instead of being pushed back by every mutation; otherwise a steady stream would starve it.
  const schedulePass = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      pass();
    }, FILTER_DEBOUNCE_MS);
  };

  const observer = new MutationObserver(schedulePass);
  pass();
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true, characterData: true });
  doc.addEventListener("visibilitychange", pass);
  if (filters.some((f) => f.schedule)) tick = setInterval(pass, SCHEDULE_TICK_MS);

  const undo = (): void => {
    if (undone) return;
    undone = true;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    if (tick !== undefined) clearInterval(tick);
    timer = undefined;
    tick = undefined;
    doc.removeEventListener("visibilitychange", pass);
    for (const el of held.keys()) release(el, holder);
    held.clear();
  };

  const handle = undo as ContentFilterHandle;
  Object.defineProperty(handle, "matched", { get: () => held.size });
  Object.defineProperty(handle, "refresh", { value: pass });
  return handle;
}

// A keyword hit on an item also matches every container around it, since text is inherited, so a
// selector like "div" would hide the whole page. Containers holding unmatched members of the same
// selector are skipped, and only the outermost hit is hidden, so a card goes as one unit. A container
// whose members all match (a podcast-only shelf) is still hidden as one piece.
function groupTargets(doc: Document, selectors: readonly string[], pattern: RegExp): HTMLElement[] {
  const hits: { el: HTMLElement; selector: string }[] = [];
  const missesAbove = new Map<HTMLElement, Set<string>>();
  const hitsAbove = new Map<HTMLElement, Set<string>>();
  for (const selector of selectors) {
    for (const el of queryItems(doc, selector)) {
      const matched = pattern.test(searchableText(el));
      if (matched) hits.push({ el, selector });
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
  for (const { el } of hits) {
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
    return Array.from(doc.querySelectorAll(selector)).filter((el): el is HTMLElement => el instanceof HTMLElement);
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
