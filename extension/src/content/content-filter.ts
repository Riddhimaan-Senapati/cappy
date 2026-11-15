import type { BlockCall } from "../../../shared/adaptation.js";
import { CLASSIFY_CACHE_LOAD_MS, CLASSIFY_CACHE_MATCHES, CLASSIFY_CACHE_TEXTS, CLASSIFY_CACHE_TTL_MS, classifyTextHash, type ClassifyHostCache } from "../../../shared/classify-cache.js";
import { activeProfileId, loadClassifyHost, saveClassifyVerdicts } from "../storage.js";
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

// Called when a filter has settled and keyword matches are still visible, so a claim like "hid Shorts" can be checked on every page.
export type LeftoverListener = (filter: Filter, count: number) => void;
let leftoverListener: LeftoverListener | null = null;
export const LEFTOVER_SETTLE_MS = 1_500;
const LEFTOVER_SCAN_MAX = 400;
// Site chrome the filter leaves alone on purpose: menus, tabs, search and bars that stay on screen.
const CHROME = "nav, header, footer, aside, form, button, [role=navigation], [role=tablist], [role=tab], [role=menu], [role=menubar], [role=banner], [role=search], [role=button]";

export function setLeftoverListener(next: LeftoverListener | null) {
  leftoverListener = next;
}

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

export function classifyTextKey(text: string): string {
  return classifyTextHash(text);
}

let cacheHost = "";
let cacheProfile = "default";
let cacheReady = true;
let cacheWrite: ReturnType<typeof setTimeout> | undefined;
const cacheWaiters = new Set<() => void>();
const pendingWrites: Record<string, Record<string, boolean>> = {};

function wakeCacheWaiters() {
  cacheReady = true;
  for (const wake of cacheWaiters) wake();
}

function adoptCache(cache: ClassifyHostCache | null) {
  if (!cache) return;
  const now = Date.now();
  for (const [match, rows] of Object.entries(cache.matches)) {
    for (const [text, row] of Object.entries(rows)) {
      if (!row || typeof row.verdict !== "boolean" || now - row.at >= CLASSIFY_CACHE_TTL_MS) continue;
      const key = verdictKey(match, text);
      if (!verdicts.has(key)) verdicts.set(key, row.verdict);
    }
  }
}

// Saved verdicts are per profile and site, one storage key per site, so a reload does not ask again.
export function beginClassifyCache(host: string): Promise<void> {
  cacheHost = host;
  if (!host) return Promise.resolve();
  cacheReady = false;
  let settled = false;
  let finish = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      wakeCacheWaiters();
      resolve();
    };
  });
  const timeout = setTimeout(finish, CLASSIFY_CACHE_LOAD_MS);
  void activeProfileId().then((profileId) => {
    cacheProfile = profileId;
    return loadClassifyHost(profileId, host);
  }).then((cache) => {
    adoptCache(cache);
  }).catch(() => undefined).then(() => {
    clearTimeout(timeout);
    finish();
  });
  return done;
}

function rememberVerdict(match: string, text: string, verdict: boolean) {
  const key = classifyTextKey(text);
  if (!pendingWrites[match]) pendingWrites[match] = {};
  const texts = pendingWrites[match];
  delete texts[key];
  texts[key] = verdict;
  const extra = Object.keys(texts);
  for (const old of extra.slice(0, Math.max(0, extra.length - CLASSIFY_CACHE_TEXTS))) delete texts[old];
  const matches = Object.keys(pendingWrites);
  for (const old of matches.slice(0, Math.max(0, matches.length - CLASSIFY_CACHE_MATCHES))) delete pendingWrites[old];
  verdicts.set(verdictKey(match, key), verdict);
  if (!cacheHost) return;
  clearTimeout(cacheWrite);
  cacheWrite = setTimeout(() => {
    const updates: Record<string, Record<string, boolean>> = {};
    for (const [name, rows] of Object.entries(pendingWrites)) updates[name] = { ...rows };
    for (const name of Object.keys(pendingWrites)) delete pendingWrites[name];
    void saveClassifyVerdicts(cacheProfile, cacheHost, updates).then((merged) => adoptCache(merged)).catch(() => undefined);
  }, 200);
}

export function clearClassifyMemory() {
  verdicts.clear();
  inFlight.clear();
  queued.clear();
  for (const key of Object.keys(pendingWrites)) delete pendingWrites[key];
}

export function onClassifyCacheReady(wake: () => void): () => void {
  if (cacheReady) return () => undefined;
  cacheWaiters.add(wake);
  return () => cacheWaiters.delete(wake);
}

const TITLE = "h1, h2, h3, h4, [id*='title' i], [class*='title' i]";

// Leading with the title keeps durations and badges from crowding out what the item is about.
function formatMark(el: HTMLElement): string {
  const links = [el, ...Array.from(el.querySelectorAll("a[href]"))].map((node) => node.getAttribute("href") ?? "").join(" ");
  const aria = el.getAttribute("aria-label") ?? "";
  const raw = `${el.tagName} ${el.getAttribute("class") ?? ""}`.toLowerCase();
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  // YouTube's Shorts tile is ytd-reel-item-renderer. "reel" in that name is not an Instagram reel.
  if (raw.includes("ytd-reel") || el.hasAttribute("data-shorts") || /\/shorts\//i.test(links) || tokens.includes("shorts") || /\bshorts\b/i.test(aria)) return "[shorts] ";
  if (el.hasAttribute("data-reel") || /\/reels?\//i.test(links) || tokens.includes("reel") || tokens.includes("reels") || /\breels?\b/i.test(aria)) return "[reel] ";
  return "";
}

export function itemText(el: HTMLElement): string {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  const title = clean(el.querySelector(TITLE)?.textContent ?? "");
  const body = clean(spacedText(el));
  return `${formatMark(el)}${title ? `${title} | ${body}` : body}`.slice(0, 240);
}

// Undefined means not judged yet; the item stays as it is until its verdict arrives.
function verdictFor(match: string, el: HTMLElement): boolean | undefined {
  const text = itemText(el);
  if (!text) return false;
  const key = verdictKey(match, classifyTextKey(text));
  if (!cacheReady) return undefined;
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
        chunk.forEach((text) => inFlight.add(verdictKey(match, classifyTextKey(text))));
        const result = await classifier?.(match, chunk).catch(() => null);
        // A failed call leaves those items shown instead of queueing them again on every scroll. Only a real answer is saved for the next visit.
        chunk.forEach((text, index) => {
          const key = verdictKey(match, classifyTextKey(text));
          inFlight.delete(key);
          if (result) rememberVerdict(match, text, Boolean(result[index]));
          else verdicts.set(key, false);
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
  let leftoverTimer: ReturnType<typeof setTimeout> | undefined;
  let undone = false;

  const checkLeftovers = (): void => {
    leftoverTimer = undefined;
    if (undone || !leftoverListener) return;
    const count = leftovers(doc, pattern);
    if (count > 0) leftoverListener(filter, count);
  };

  // Groups seen once stay in the set: a group whose items are all hidden no longer looks like a group, and would otherwise be un-hidden.
  const selectorsToCheck = (): string[] => {
    // A selector saved on one page of a site (a home feed card) may not exist on another (search results); then fall back to the page's own groups.
    if (filter.itemSelector && queryItems(doc, filter.itemSelector).length > 0) return [filter.itemSelector];
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
    for (const el of targets(doc, selectorsToCheck(), matches, (el) => pattern.test(el.textContent?.toLowerCase() ?? ""))) desired.set(el, filter.action);

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
    if (filter.action === "hide" && leftoverListener) {
      clearTimeout(leftoverTimer);
      leftoverTimer = setTimeout(checkLeftovers, LEFTOVER_SETTLE_MS);
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
  const stopCacheWait = onClassifyCacheReady(schedulePass);
  pass();
  const observer = new MutationObserver(schedulePass);
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true, characterData: true });

  const undo = (): void => {
    if (undone) return;
    undone = true;
    stopCacheWait();
    if (match) waiting.get(match)?.delete(schedulePass);
    observer.disconnect();
    clearTimeout(leftoverTimer);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const el of held.keys()) release(el, holder);
    held.clear();
  };

  return { undo, matched: () => held.size };
}

// Links that still name the filtered thing ("/shorts/abc", "Podcasts") and are on screen, outside site chrome.
export function leftovers(doc: Document, pattern: RegExp): number {
  let count = 0;
  const links = Array.from(doc.querySelectorAll<HTMLElement>("a[href]")).slice(0, LEFTOVER_SCAN_MAX * 5);
  for (const link of links) {
    if (isOwn(link) || link.closest(CHROME)) continue;
    const text = `${link.getAttribute("href") ?? ""} ${link.getAttribute("aria-label") ?? ""} ${link.textContent ?? ""}`.toLowerCase();
    if (!pattern.test(text) || !shown(link) || pinned(link)) continue;
    count++;
    if (count >= LEFTOVER_SCAN_MAX) break;
  }
  return count;
}

function shown(el: HTMLElement): boolean {
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(el);
  for (let a: HTMLElement | null = el; a; a = a.parentElement) if (a.style.display === "none") return false;
  return true;
}

// Fixed and sticky bars are site chrome such as a side menu, which the filter leaves in place.
function pinned(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let a: HTMLElement | null = el.parentElement; a && a !== el.ownerDocument.body; a = a.parentElement) {
    const position = view.getComputedStyle(a).position;
    if (position === "fixed" || position === "sticky") return true;
  }
  return false;
}

const HEADING = "h1, h2, h3, h4, [role=heading], #title";
const PAGE_REGION = "main, [role=main], #content, #primary";

// A keyword hit on an item also matches every container around it, since text is inherited, so a
// selector like "div" would hide the whole page. A container holding any unmatched item (from any
// selector) is skipped, and only the outermost hit is hidden, so a card goes as one unit.
// A shelf whose own heading matches ("Podcasts", "Shorts") is about that topic and goes whole, heading included.
// Nothing that holds the page's main region is ever hidden.
function targets(doc: Document, selectors: readonly string[], matches: (el: HTMLElement) => boolean, headingMatches: (el: HTMLElement) => boolean): HTMLElement[] {
  const items = new Set<HTMLElement>();
  for (const selector of selectors) for (const el of queryItems(doc, selector)) items.add(el);

  const hits: HTMLElement[] = [];
  const titled = new Set<HTMLElement>();
  const holdsMiss = new Set<HTMLElement>();
  for (const el of items) {
    const heading = ownHeading(el, items);
    const named = heading !== null && headingMatches(heading);
    if (named) titled.add(el);
    if (named || matches(el)) {
      hits.push(el);
      continue;
    }
    for (let a = el.parentElement; a; a = a.parentElement) holdsMiss.add(a);
  }

  const region = doc.querySelector(PAGE_REGION);
  const candidates = new Set<HTMLElement>();
  for (const el of hits) {
    if (region && el.contains(region)) continue;
    // A matching heading names a shelf, not a whole result list: one holding most of the page's items stays.
    if (holdsMiss.has(el) && !(titled.has(el) && share(el, items) <= 0.5)) continue;
    candidates.add(el);
  }
  const outermost = [...candidates].filter((el) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (candidates.has(a)) return false;
    return true;
  });
  const cards = new Set(outermost.map((el) => cardOf(el, region)));
  return [...cards].filter((el) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (cards.has(a)) return false;
    return true;
  });
}

// A matched link can sit inside a larger card (a Short's title link inside its tile); hiding only the link leaves the
// card's text and space behind. Climb while the wrapper links nowhere else, so the card goes but its neighbours stay.
const MAX_CARD_CLIMB = 6;
function cardOf(el: HTMLElement, region: Element | null): HTMLElement {
  const href = el.localName === "a" ? el.getAttribute("href") : null;
  if (!href) return el;
  let card: HTMLElement = el;
  let parent = el.parentElement;
  for (let depth = 0; parent && parent !== el.ownerDocument.body && depth < MAX_CARD_CLIMB; depth++, parent = parent.parentElement) {
    if (region && parent.contains(region)) break;
    const elsewhere = Array.from(parent.querySelectorAll("a[href]")).some((link) => link.getAttribute("href") !== href);
    if (elsewhere) break;
    card = parent;
  }
  return card;
}

function share(el: HTMLElement, items: ReadonlySet<HTMLElement>): number {
  let inside = 0;
  for (const item of items) if (item !== el && el.contains(item)) inside++;
  return items.size ? inside / items.size : 0;
}

// The first heading that belongs to this element rather than to an item nested inside it.
function ownHeading(el: HTMLElement, items: ReadonlySet<HTMLElement>): HTMLElement | null {
  for (const heading of Array.from(el.querySelectorAll<HTMLElement>(HEADING))) {
    let owner: HTMLElement | null = heading.parentElement;
    while (owner && owner !== el && !items.has(owner)) owner = owner.parentElement;
    if (owner === el) return heading;
  }
  return null;
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
  // An item that is itself a link ("a[href*='/shorts/']" groups) is named by its own address.
  if (el.localName === "a") parts.push(el.getAttribute("href") ?? "");
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
