import { ItemSelector, type ItemGroup } from "@browser-agent/shared";

export const GROUP_MAX = 20;
const SECTION_RESERVE = 6;
const SCAN_MAX = 8000;
const MIN_TEXT = 15;
const SAMPLE_MAX = 3;
const SAMPLE_TEXT_MAX = 100;
const MAIN_SELECTOR = "main, [role=main], #content, #primary";
const SKIP_TAGS = new Set(["script", "style", "svg", "noscript", "template", "iframe", "head", "meta", "link"]);
const STABLE_CLASS = /^[a-z][a-z0-9_-]{1,23}$/i;
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role=heading], #title";

type Candidate = { selector: string; elements: Element[] };

// Groups are selector based so they survive re-renders and later visits, unlike snapshot ids.
export function findItemGroups(doc: Document): ItemGroup[] {
  const root = (doc.querySelector(MAIN_SELECTOR) ?? doc.body ?? doc.documentElement) as Element | null;
  if (!root) return [];

  const bySelector = new Map<string, Candidate>();
  const sectionBySelector = new Map<string, Candidate>();
  let scanned = 0;

  const visit = (el: Element): void => {
    if (scanned >= SCAN_MAX) return;
    scanned += 1;
    if (SKIP_TAGS.has(el.localName) || el.hasAttribute("data-ba") || el.hasAttribute("hidden")) return;
    if (doc.defaultView?.getComputedStyle(el).display === "none") return;

    const text = normalize(el.textContent ?? "");
    if (text.length >= MIN_TEXT) {
      const selector = signature(el);
      if (selector) {
        if (isSectionLike(el) && headingText(el)) addTo(sectionBySelector, selector, el);
        addTo(bySelector, selector, el);
      }
    }
    for (const child of Array.from(el.children)) visit(child);
  };

  visit(root);

  const groups: { order: number; group: ItemGroup }[] = [];
  const seen = new Set<string>();
  let order = 0;

  for (const candidate of bySelector.values()) {
    if (!qualifies(candidate)) continue;
    const group = toGroup(doc, candidate.selector, candidate.elements);
    if (!group) continue;
    seen.add(group.selector);
    groups.push({ order: order++, group });
  }

  const sections: { order: number; group: ItemGroup }[] = [];
  for (const candidate of sectionBySelector.values()) {
    const heading = headingText(candidate.elements[0]!);
    if (!heading) continue;
    const group = toGroup(doc, candidate.selector, candidate.elements, heading);
    if (!group || seen.has(group.selector)) continue;
    sections.push({ order: order++, group });
  }

  const byCount = (a: { group: ItemGroup }, b: { group: ItemGroup }) => b.group.count - a.group.count;
  const topSections = sections.sort(byCount).slice(0, SECTION_RESERVE);
  const topItems = groups.sort(byCount).slice(0, GROUP_MAX - topSections.length);

  // Document order puts an outer container before the items it holds, so the outer group reads first.
  return [...topItems, ...topSections]
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.group);
}

function addTo(map: Map<string, Candidate>, selector: string, el: Element): void {
  let candidate = map.get(selector);
  if (!candidate) {
    candidate = { selector, elements: [] };
    map.set(selector, candidate);
  }
  candidate.elements.push(el);
}

// Three or more items anywhere, or two that sit side by side under one parent.
function qualifies({ elements }: Candidate): boolean {
  if (elements.length >= 3) return true;
  if (elements.length < 2) return false;
  const parents = new Set(elements.map((el) => el.parentElement));
  return parents.size < elements.length;
}

function toGroup(doc: Document, selector: string, elements: Element[], heading?: string): ItemGroup | undefined {
  if (!ItemSelector.safeParse(selector).success) return undefined;
  let count: number;
  try {
    count = doc.querySelectorAll(selector).length;
  } catch {
    return undefined;
  }
  if (count < 1) return undefined;
  const samples = heading
    ? [heading]
    : elements
        .slice(0, SAMPLE_MAX)
        .map((el) => normalize(el.textContent ?? "").slice(0, SAMPLE_TEXT_MAX));
  return { selector, count, samples };
}

// Custom elements are identified by tag alone; plain tags add stable classes to tell card kinds apart.
export function signature(el: Element): string | undefined {
  const tag = el.localName;
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return undefined;
  if (tag.includes("-")) return tag;
  const classes = Array.from(el.classList).filter(isStableClass).slice(0, 2);
  return [tag, ...classes.map((c) => `.${c}`)].join("");
}

function isStableClass(cls: string): boolean {
  if (!STABLE_CLASS.test(cls)) return false;
  const digits = cls.match(/\d/g)?.length ?? 0;
  return digits < 3;
}

function isSectionLike(el: Element): boolean {
  return el.localName === "section" || el.localName.includes("shelf") || el.localName.includes("section");
}

function headingText(el: Element): string | undefined {
  const heading = el.querySelector(HEADING_SELECTOR);
  const text = normalize(heading?.textContent ?? "").slice(0, SAMPLE_TEXT_MAX);
  return text.length > 0 ? text : undefined;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
