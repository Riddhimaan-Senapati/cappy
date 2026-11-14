import type { ItemGroup } from "../../../shared/adaptation.js";
import { adapterGroups, mergeGroups } from "./site-adapters.js";

export const GROUP_CAP = 20;
const SECTION_RESERVE = 6;
const SCAN_MAX = 8000;
const MIN_TEXT = 15;
const MIN_ITEMS = 3;
const MAX_ITEMS = 200;
const MAX_SETS = 400;
const SHAPE_MIN = 0.4;
const SHAPE_KEEP = 0.75;
const SHAPE_SCAN = 200;
const PATH_MAX = 6;
const FIT_RATIO = 1.5;
const FIT_COVER = 0.66;
const SAMPLE_MAX = 3;
const SAMPLE_TEXT_MAX = 100;
const MAIN_SELECTOR = "main, [role=main], #content, #primary";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role=heading], #title";
const MEDIA_SELECTOR = "img, video, a[href]";
const SKIP_TAGS = new Set(["script", "style", "svg", "noscript", "template", "iframe", "head", "meta", "link"]);
// Hashed atomic classes (x1lliihq, css-1x2y3z) always carry digits, so digit-free names are the stable ones.
const STABLE_NAME = /^[a-z][a-z_-]{1,29}$/i;
const STABLE_ATTRS = ["data-testid", "data-test-id", "data-e2e", "data-qa", "role", "aria-label"];
const STABLE_VALUE = /^[\w .:-]{1,60}$/;
const ANCHOR_ROLES = new Set(["main", "feed", "list", "grid"]);
const ANCHOR_TAGS = new Set(["main", "article", "section", "body"]);
const LINK_KEY = /^(?:https?:\/\/[^/]+)?\/([a-z][\w-]{0,30})\//;
const ELEMENT_NODE = 1;
const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

type Found = { elements: Element[]; selector: string; count: number; heading?: string };
type Candidate = { tier: number; depth: number; rank: number; size: number; build: () => Found | undefined };

// Adapter groups for known sites first, then generic detection. Selectors (not element refs) are returned so they survive re-renders.
export function detectItemGroups(doc: Document, host: string): ItemGroup[] {
  return mergeGroups(adapterGroups(host, doc), findItemGroups(doc), GROUP_CAP);
}

export function findItemGroups(doc: Document): ItemGroup[] {
  const root = (doc.querySelector(MAIN_SELECTOR) ?? doc.body ?? doc.documentElement) as Element | null;
  if (!root) return [];

  const scanned = scan(doc, root);
  const order = new Map(scanned.map((el, i) => [el, i]));
  const claims = new Claims();
  const candidates: Candidate[] = [];

  for (const set of containerSets(scanned, root, order)) {
    const preferredHit = fitted(doc, preferredSelectors(set), set);
    const found = preferredHit ?? structural(doc, set);
    if (!found) continue;
    candidates.push({
      tier: set.length >= MIN_ITEMS ? 0 : 1,
      depth: depthOf(set[0]!),
      rank: preferredHit ? 0 : 2,
      size: set.length,
      build: () => found,
    });
  }

  for (const [key, links] of linkSets(scanned)) {
    candidates.push({
      tier: links.length >= MIN_ITEMS ? 0 : 1,
      depth: Math.min(...links.map(depthOf)),
      rank: 1,
      size: links.length,
      build: () => {
        const free = links.filter((el) => !claims.taken(el) && labelled(el));
        return free.length >= MIN_ITEMS ? fitted(doc, [`a[href*="/${key}/"]`], free) : undefined;
      },
    });
  }

  const items: Found[] = [];
  for (const candidate of candidates.sort(byPriority)) {
    const found = candidate.build();
    if (found && claims.claimIfFree(found)) items.push(found);
  }

  const sections = sectionGroups(doc, scanned).filter((s) => !items.some((i) => i.selector === s.selector));
  const topSections = sections.sort(byCount).slice(0, SECTION_RESERVE);
  const topItems = items.sort(byCount).slice(0, GROUP_CAP - topSections.length);

  return [...topItems, ...topSections]
    .sort((a, b) => inDocumentOrder(a.elements[0]!, b.elements[0]!))
    .map(toItemGroup);
}

function scan(doc: Document, root: Element): Element[] {
  const view = doc.defaultView;
  const out: Element[] = [];
  const stack = Array.from(root.children).reverse();
  while (stack.length > 0 && out.length < SCAN_MAX) {
    const el = stack.pop()!;
    if (SKIP_TAGS.has(el.localName) || el.hasAttribute("data-ba") || el.hasAttribute("hidden")) continue;
    if (view?.getComputedStyle(el).display === "none") continue;
    out.push(el);
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]!);
  }
  return out;
}

// Candidate item sets: same-signature elements anywhere, and same-tag siblings under one parent.
function containerSets(scanned: Element[], root: Element, order: Map<Element, number>): Element[][] {
  const itemCache = new Map<Element, boolean>();
  const isItem = (el: Element): boolean => {
    let value = itemCache.get(el);
    if (value === undefined) {
      value = meaningful(el);
      itemCache.set(el, value);
    }
    return value;
  };
  const sets = new Map<string, Element[]>();
  const keep = (members: Element[]): void => {
    const shaped = sameShape(members);
    if (!shaped || shaped.length > MAX_ITEMS || hasNesting(shaped)) return;
    const id = shaped.map((el) => order.get(el)).join(",");
    if (!sets.has(id)) sets.set(id, shaped);
  };

  const bySignature = new Map<string, Element[]>();
  for (const el of scanned) {
    const key = signature(el);
    if (!key || !isItem(el)) continue;
    pushTo(bySignature, key, el);
  }
  for (const members of bySignature.values()) {
    if (members.length >= MIN_ITEMS || (members.length >= 2 && sharesParent(members))) keep(members);
  }

  const parents = new Set<Element>([root]);
  for (const el of scanned) if (el.parentElement) parents.add(el.parentElement);
  for (const parent of parents) {
    const byTag = new Map<string, Element[]>();
    for (const child of Array.from(parent.children)) {
      if (order.has(child) && isItem(child)) pushTo(byTag, child.localName, child);
    }
    for (const members of byTag.values()) {
      if (members.length >= MIN_ITEMS) keep(members);
    }
  }

  return [...sets.values()]
    .sort((a, b) => depthOf(a[0]!) - depthOf(b[0]!) || b.length - a.length)
    .slice(0, MAX_SETS);
}

function linkSets(scanned: Element[]): Map<string, Element[]> {
  const byKey = new Map<string, Element[]>();
  for (const el of scanned) {
    if (el.localName !== "a") continue;
    const match = LINK_KEY.exec(el.getAttribute("href") ?? "");
    if (match) pushTo(byKey, match[1]!, el);
  }
  return byKey;
}

function sectionGroups(doc: Document, scanned: Element[]): Found[] {
  const bySignature = new Map<string, Element[]>();
  for (const el of scanned) {
    if (!isSectionLike(el) || !headingText(el)) continue;
    const key = signature(el);
    if (key) pushTo(bySignature, key, el);
  }
  const out: Found[] = [];
  for (const members of bySignature.values()) {
    const found = fitted(doc, preferredSelectors(members), members) ?? structural(doc, members);
    if (found) out.push({ ...found, heading: headingText(members[0]!) });
  }
  return out;
}

function preferredSelectors(elements: Element[]): string[] {
  const tag = elements[0]!.localName;
  const out: string[] = [];
  if (tag.includes("-")) out.push(tag);
  for (const attr of STABLE_ATTRS) {
    const value = sharedAttr(elements, attr);
    if (value !== undefined) out.push(`${tag}[${attr}="${value}"]`);
  }
  const classes = sharedClasses(elements);
  if (classes.length >= 2) out.push(`${tag}.${classes[0]}.${classes[1]}`);
  if (classes.length >= 1) out.push(`${tag}.${classes[0]}`);
  out.push(tag);
  return out;
}

// Path from the nearest stable ancestor using tag names and child combinators only, so it survives class hashing.
function structural(doc: Document, elements: Element[]): Found | undefined {
  const selector = pathSelector(elements[0]!);
  return selector ? fitted(doc, [selector], elements) : undefined;
}

function pathSelector(el: Element): string | undefined {
  const steps = [el.localName];
  let node = el.parentElement;
  for (let depth = 0; node && depth < PATH_MAX; depth++, node = node.parentElement) {
    const anchor = anchorOf(node);
    if (anchor) return [anchor, ...steps].join(" > ");
    steps.unshift(node.localName);
  }
  return undefined;
}

function anchorOf(el: Element): string | undefined {
  const role = el.getAttribute("role");
  if (role && ANCHOR_ROLES.has(role)) return `[role="${role}"]`;
  if (ANCHOR_TAGS.has(el.localName)) return el.localName;
  if (el.id && isStableName(el.id)) return `#${el.id}`;
  return undefined;
}

function fitted(doc: Document, selectors: string[], elements: Element[]): Found | undefined {
  for (const selector of selectors) {
    const count = fitCount(doc, selector, elements);
    if (count !== undefined) return { elements, selector, count };
  }
  return undefined;
}

// A selector fits when it matches about as many nodes as the detected items and mostly those items.
function fitCount(doc: Document, selector: string, elements: Element[]): number | undefined {
  if (!isSafeSelector(selector)) return undefined;
  let matched: Element[];
  try {
    matched = Array.from(doc.querySelectorAll(selector));
  } catch {
    return undefined;
  }
  const n = elements.length;
  const m = matched.length;
  if (m === 0 || m > Math.ceil(n * FIT_RATIO)) return undefined;
  const members = new Set(elements);
  const inside = matched.filter((el) => members.has(el)).length;
  return inside >= n * FIT_COVER && inside >= m * FIT_COVER ? m : undefined;
}

// Same character rules the validator uses for filter selectors, so a detected selector can always be applied.
export function isSafeSelector(selector: string): boolean {
  return selector.length > 0 && selector.length <= 160 && !/[{};@\\<]/.test(selector);
}

function sharedAttr(elements: Element[], attr: string): string | undefined {
  const first = elements[0]!.getAttribute(attr);
  if (!first || !STABLE_VALUE.test(first)) return undefined;
  return elements.every((el) => el.getAttribute(attr) === first) ? first : undefined;
}

function sharedClasses(elements: Element[]): string[] {
  const [first, ...rest] = elements;
  return Array.from(first!.classList)
    .filter(isStableName)
    .filter((cls) => rest.every((el) => el.classList.contains(cls)));
}

// Custom elements are identified by tag alone; plain tags add stable classes to tell card kinds apart.
function signature(el: Element): string | undefined {
  const tag = el.localName;
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return undefined;
  if (tag.includes("-")) return tag;
  const classes = Array.from(el.classList).filter(isStableName).slice(0, 2);
  return [tag, ...classes.map((c) => `.${c}`)].join("");
}

function isStableName(name: string): boolean {
  return STABLE_NAME.test(name);
}

function meaningful(el: Element): boolean {
  if (normalize(el.textContent ?? "").length >= MIN_TEXT) return true;
  return el.matches(MEDIA_SELECTOR) || el.querySelector(MEDIA_SELECTOR) !== null;
}

function labelled(el: Element): boolean {
  return normalize(el.textContent ?? "").length > 0 || el.hasAttribute("aria-label") || el.querySelector("img") !== null;
}

function sameShape(members: Element[]): Element[] | undefined {
  // Many siblings with the same custom element tag are a site's own item component, whatever their inner markup.
  const tag = members[0]!.localName;
  if (tag.includes("-") && members.every((m) => m.localName === tag)) return members;
  const proto = shapeOf(members[0]!);
  const kept = members.filter((member) => similarity(proto, shapeOf(member)) >= SHAPE_MIN);
  return kept.length >= Math.max(2, Math.ceil(members.length * SHAPE_KEEP)) ? kept : undefined;
}

function shapeOf(el: Element): Set<string> {
  return new Set(
    Array.from(el.getElementsByTagName("*"))
      .slice(0, SHAPE_SCAN)
      .map((d) => d.localName),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const tag of a) if (b.has(tag)) shared++;
  return shared / (a.size + b.size - shared);
}

function hasNesting(members: Element[]): boolean {
  const set = new Set(members);
  return members.some((member) => {
    for (let p = member.parentElement; p; p = p.parentElement) if (set.has(p)) return true;
    return false;
  });
}

function sharesParent(members: Element[]): boolean {
  return new Set(members.map((m) => m.parentElement)).size < members.length;
}

function isSectionLike(el: Element): boolean {
  return el.localName === "section" || el.localName.includes("shelf") || el.localName.includes("section");
}

function headingText(el: Element): string | undefined {
  const text = normalize(el.querySelector(HEADING_SELECTOR)?.textContent ?? "").slice(0, SAMPLE_TEXT_MAX);
  return text.length > 0 ? text : undefined;
}

function toItemGroup(found: Found): ItemGroup {
  const samples = found.heading ? [found.heading] : found.elements.slice(0, SAMPLE_MAX).map(sampleText);
  return found.heading
    ? { selector: found.selector, count: found.count, samples, label: found.heading }
    : { selector: found.selector, count: found.count, samples };
}

// Text first; otherwise the label or link, so icon-only tiles (reels, thumbnails) stay recognisable.
function sampleText(el: Element): string {
  const text = normalize(el.textContent ?? "");
  if (text) return text.slice(0, SAMPLE_TEXT_MAX);
  const label = normalize(
    el.getAttribute("aria-label") ??
      el.querySelector("[aria-label]")?.getAttribute("aria-label") ??
      el.querySelector("img[alt]")?.getAttribute("alt") ??
      "",
  );
  const href = el.getAttribute("href") ?? el.querySelector("a[href]")?.getAttribute("href") ?? "";
  const sample = label && href ? `${label}: ${href}` : label || href || el.localName;
  return sample.slice(0, SAMPLE_TEXT_MAX);
}

function inDocumentOrder(a: Element, b: Element): number {
  const position = a.compareDocumentPosition(b);
  if (position & DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function byCount(a: Found, b: Found): number {
  return b.count - a.count;
}

// Pairs come last so they cannot claim a link group that would otherwise be the item; at equal depth a
// preferred selector beats a link pattern, which beats a structural path.
function byPriority(a: Candidate, b: Candidate): number {
  return a.tier - b.tier || a.depth - b.depth || a.rank - b.rank || b.size - a.size;
}

function depthOf(el: Element): number {
  let depth = 0;
  for (let p = el.parentElement; p; p = p.parentElement) depth++;
  return depth;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Outer groups claim their elements first, so inner repeats (a post's inner divs) and overlapping link groups are dropped.
class Claims {
  private readonly own = new Set<Element>();
  private readonly around = new Set<Element>();

  taken(el: Element): boolean {
    if (this.own.has(el) || this.around.has(el)) return true;
    for (let p = el.parentElement; p; p = p.parentElement) if (this.own.has(p)) return true;
    return false;
  }

  claimIfFree(found: Found): boolean {
    if (found.elements.some((el) => this.taken(el))) return false;
    for (const el of found.elements) {
      this.own.add(el);
      for (let p = el.parentElement; p && !this.around.has(p); p = p.parentElement) this.around.add(p);
    }
    return true;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
