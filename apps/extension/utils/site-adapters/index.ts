import { ItemSelector, type ItemGroup } from "@browser-agent/shared";
import { SITE_ADAPTERS, type SiteAdapter } from "./adapters";

export { KIND_HINTS, SITE_ADAPTERS, type SiteAdapter } from "./adapters";

export const GROUP_CAP = 20;
const SAMPLE_MAX = 3;
const SAMPLE_TEXT_MAX = 100;

export function adapterFor(host: string): SiteAdapter | undefined {
  const name = host.toLowerCase();
  return SITE_ADAPTERS.find((adapter) =>
    adapter.hosts.some((h) => name === h || name.endsWith(`.${h}`)),
  );
}

// Groups with no matches are dropped: ItemGroup requires a positive count.
export function adapterGroups(host: string, doc: Document): ItemGroup[] {
  const adapter = adapterFor(host);
  if (!adapter) return [];
  const groups: ItemGroup[] = [];
  for (const spec of adapter.groups) {
    if (!ItemSelector.safeParse(spec.selector).success) continue;
    let items: Element[];
    try {
      items = Array.from(doc.querySelectorAll(spec.selector));
    } catch {
      continue;
    }
    if (items.length === 0) continue;
    groups.push({
      selector: spec.selector,
      count: items.length,
      samples: items.slice(0, SAMPLE_MAX).map((el) => normalize(el.textContent ?? "").slice(0, SAMPLE_TEXT_MAX)),
      label: spec.label,
      source: "adapter",
    });
  }
  return groups;
}

// The first list wins on a duplicate selector, so adapter groups go first.
export function mergeGroups(primary: ItemGroup[], secondary: ItemGroup[]): ItemGroup[] {
  const seen = new Set<string>();
  const merged: ItemGroup[] = [];
  for (const group of [...primary, ...secondary]) {
    if (seen.has(group.selector)) continue;
    seen.add(group.selector);
    merged.push(group);
    if (merged.length === GROUP_CAP) break;
  }
  return merged;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
