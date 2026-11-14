import type { ItemGroup } from "../../../shared/adaptation.js";

export interface SiteAdapter {
  hosts: string[];
  groups: Array<{ selector: string; label: string }>;
}

// Selectors target whole cards with stable attributes so they keep matching items added while scrolling.
export const SITE_ADAPTERS: SiteAdapter[] = [
  {
    hosts: ["youtube.com"],
    groups: [
      { selector: "ytd-rich-item-renderer", label: "Video card" },
      { selector: "ytd-rich-section-renderer", label: "Shelf (Shorts, Podcasts, ...)" },
      { selector: "ytd-reel-shelf-renderer", label: "Shorts shelf" },
      { selector: "ytd-rich-shelf-renderer[is-shorts]", label: "Shorts shelf" },
      { selector: "ytd-video-renderer", label: "Search result video" },
      { selector: "ytd-compact-video-renderer", label: "Sidebar recommendation" },
      { selector: "ytd-ad-slot-renderer", label: "Ad" },
    ],
  },
  {
    hosts: ["instagram.com"],
    groups: [
      { selector: "article", label: "Feed post" },
      { selector: 'a[href*="/reel/"]', label: "Reel" },
      { selector: 'main a[href*="/p/"]', label: "Post tile" },
    ],
  },
  {
    hosts: ["x.com", "twitter.com"],
    groups: [
      { selector: 'article[data-testid="tweet"]', label: "Post" },
      { selector: '[data-testid="trend"]', label: "Trend" },
    ],
  },
  {
    hosts: ["reddit.com"],
    groups: [
      { selector: "shreddit-post", label: "Post" },
      { selector: "shreddit-ad-post", label: "Promoted post" },
    ],
  },
  {
    hosts: ["tiktok.com"],
    groups: [{ selector: '[data-e2e="recommend-list-item-container"]', label: "Video" }],
  },
  {
    hosts: ["linkedin.com"],
    groups: [
      { selector: '[data-id^="urn:li:activity"]', label: "Feed post" },
      { selector: "div.feed-shared-update-v2", label: "Feed post (alt)" },
    ],
  },
  {
    hosts: ["news.ycombinator.com"],
    groups: [{ selector: "tr.athing", label: "Story" }],
  },
];

export function adapterFor(host: string): SiteAdapter | undefined {
  const name = host.toLowerCase();
  return SITE_ADAPTERS.find((adapter) => adapter.hosts.some((h) => name === h || name.endsWith(`.${h}`)));
}

// Groups with no matches are dropped, since an item group needs at least one item.
export function adapterGroups(host: string, doc: Document): ItemGroup[] {
  const adapter = adapterFor(host);
  if (!adapter) return [];
  const groups: ItemGroup[] = [];
  for (const spec of adapter.groups) {
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
      samples: items.slice(0, 3).map((el) => normalize(el.textContent ?? "").slice(0, 100)),
      label: spec.label,
    });
  }
  return groups;
}

// Adapter groups come first, so a site's own card selector wins over a generic guess for the same element.
export function mergeGroups(primary: ItemGroup[], secondary: ItemGroup[], cap: number): ItemGroup[] {
  const seen = new Set<string>();
  const merged: ItemGroup[] = [];
  for (const group of [...primary, ...secondary]) {
    if (seen.has(group.selector)) continue;
    seen.add(group.selector);
    merged.push(group);
    if (merged.length === cap) break;
  }
  return merged;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
