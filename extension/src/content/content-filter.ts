import type { BlockCall } from "../../../shared/adaptation.js";
import { isOwn } from "./dom.js";
import { findItemGroups } from "./item-groups.js";

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

export type Classifier = (match: string, items: string[]) => Promise<boolean[] | null>;

const CLASSIFY_BATCH = 40;
const CLASSIFY_DELAY_MS = 250;
let classifier: Classifier | null = null;
const verdicts = new Map<string, boolean>();
const inFlight = new Set<string>();
const queued = new Map<string, Set<string>>();
const waiting = new Map<string, Set<() => void>>();
let classifyTimer: ReturnType<typeof setTimeout> | undefined;

// Hiding items makes feeds load more, so a page that is mostly matches would be judged forever without a stop.
const JUDGE_BUDGET = 200;
const SATURATION_MIN = 30;
const SATURATION_RATIO = 0.8;
export type FilterPause = "mostly" | "budget";
type Usage = { judged: number; matched: number; paused: boolean; resumed: boolean };
const usage = new Map<string, Usage>();
let onPause: ((match: string, reason: FilterPause, judged: number, resume: () => void) => void) | null = null;

export function setFilterClassifier(next: Classifier | null) {
  classifier = next;
}

export function setFilterPauseNotice(next: typeof onPause) {
  onPause = next;
}

function usageFor(match: string): Usage {
  if (!usage.has(match)) usage.set(match, { judged: 0, matched: 0, paused: false, resumed: false });
  return usage.get(match)!;
}

function resumeJudging(match: string) {
  usage.set(match, { judged: 0, matched: 0, paused: false, resumed: true });
  waiting.get(match)?.forEach((wake) => wake());
}

function pauseIfNeeded(match: string) {
  const state = usageFor(match);
  if (state.paused) return;
  const mostly = !state.resumed && state.judged >= SATURATION_MIN && state.matched / state.judged >= SATURATION_RATIO;
  const spent = state.judged >= JUDGE_BUDGET;
  if (!mostly && !spent) return;
  state.paused = true;
  onPause?.(match, mostly ? "mostly" : "budget", state.judged, () => resumeJudging(match));
}

const verdictKey = (match: string, text: string) => `${match}\u0000${text}`;

const TITLE = "h1, h2, h3, h4, [id*='title' i], [class*='title' i]";

// Leading with the title keeps durations and badges from crowding out what the item is about.
export function itemText(el: HTMLElement): string {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  const title = clean(el.querySelector(TITLE)?.textContent ?? "");
  const body = clean(spacedText(el));
  return (title ? `${title} | ${body}` : body).slice(0, 240);
}

// Undefined means not judged yet; the item stays as it is until its verdict arrives.
function verdictFor(match: string, el: HTMLElement): boolean | undefined {
  const text = itemText(el);
  if (!text) return false;
  const key = verdictKey(match, text);
  const verdict = verdicts.get(key);
  if (verdict !== undefined || !classifier || inFlight.has(key) || usageFor(match).paused) return verdict;
  if (!queued.has(match)) queued.set(match, new Set());
  queued.get(match)!.add(text);
  if (classifyTimer === undefined) classifyTimer = setTimeout(() => void flushClassify(), CLASSIFY_DELAY_MS);
  return undefined;
}

async function flushClassify() {
  classifyTimer = undefined;
  const batches = [...queued.entries()];
  queued.clear();
  await Promise.all(
    batches.map(async ([match, texts]) => {
      const all = [...texts];
      for (let start = 0; start < all.length; start += CLASSIFY_BATCH) {
        const state = usageFor(match);
        if (state.paused) break;
        const chunk = all.slice(start, start + Math.min(CLASSIFY_BATCH, Math.max(1, JUDGE_BUDGET - state.judged)));
        chunk.forEach((text) => inFlight.add(verdictKey(match, text)));
        const result = await classifier?.(match, chunk).catch(() => null);
        // A failed call leaves those items shown instead of queueing them again on every scroll.
        chunk.forEach((text, index) => {
          inFlight.delete(verdictKey(match, text));
          verdicts.set(verdictKey(match, text), Boolean(result?.[index]));
        });
        state.judged += chunk.length;
        state.matched += result ? result.filter(Boolean).length : 0;
        pauseIfNeeded(match);
        waiting.get(match)?.forEach((wake) => wake());
      }
    }),
  );
}

export function applyContentFilter(filter: Filter, doc: Document): ContentFilterHandle {
  const holder = {};
  const held = new Map<HTMLElement, Action>();
  const groupSelectors = new Set<string>();
  const pattern = keywordPattern(filter.keywords);
  const match = filter.match?.trim() || null;
  const matches = (el: HTMLElement) => pattern.test(searchableText(el)) || (match !== null && verdictFor(match, el) === true);
  let groupsAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let undone = false;

  // Groups seen once stay in the set: a group whose items are all hidden no longer looks like a group, and would otherwise be un-hidden.
  const selectorsToCheck = (): string[] => {
    if (filter.itemSelector) return [filter.itemSelector];
    const now = Date.now();
    if (now - groupsAt >= GROUP_REFRESH_MS) {
      groupsAt = now;
      for (const group of findItemGroups(doc)) groupSelectors.add(group.selector);
    }
    return [...groupSelectors];
  };

  const pass = (): void => {
    if (undone) return;
    const desired = new Map<HTMLElement, Action>();
    for (const el of targets(doc, selectorsToCheck(), matches)) desired.set(el, filter.action);

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

  if (match) {
    if (!waiting.has(match)) waiting.set(match, new Set());
    waiting.get(match)!.add(schedulePass);
  }
  pass();
  const observer = new MutationObserver(schedulePass);
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true, characterData: true });

  const undo = (): void => {
    if (undone) return;
    undone = true;
    if (match) waiting.get(match)?.delete(schedulePass);
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
function targets(doc: Document, selectors: readonly string[], matches: (el: HTMLElement) => boolean): HTMLElement[] {
  const hits: HTMLElement[] = [];
  const missesAbove = new Map<HTMLElement, Set<string>>();
  const hitsAbove = new Map<HTMLElement, Set<string>>();
  for (const selector of selectors) {
    for (const el of queryItems(doc, selector)) {
      const matched = matches(el);
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
