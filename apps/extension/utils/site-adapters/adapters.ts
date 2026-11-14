export type SiteAdapter = {
  hosts: string[];
  groups: Array<{ selector: string; label: string; kindHints?: string[] }>;
};

// Keys are labels a group's kindHints may name; values are keywords a filter can match against item text.
export const KIND_HINTS: Record<string, string[]> = {
  "Promoted post": ["promoted", "sponsored", "ad"],
  Ad: ["ad", "sponsored"],
  Reel: ["reel"],
  "Shorts shelf": ["shorts"],
  Podcast: ["podcast"],
};

// Selectors target whole cards with stable attributes so they keep matching items added while scrolling.
export const SITE_ADAPTERS: SiteAdapter[] = [
  {
    hosts: ["youtube.com"],
    groups: [
      { selector: "ytd-rich-item-renderer", label: "Video card", kindHints: ["Ad", "Podcast"] },
      { selector: "ytd-rich-section-renderer", label: "Shelf (Shorts, Podcasts, …)", kindHints: ["Shorts shelf", "Podcast"] },
      { selector: "ytd-reel-shelf-renderer", label: "Shorts shelf", kindHints: ["Shorts shelf"] },
      { selector: "ytd-rich-shelf-renderer[is-shorts]", label: "Shorts shelf", kindHints: ["Shorts shelf"] },
      { selector: "ytd-video-renderer", label: "Search result video", kindHints: ["Ad", "Podcast"] },
      { selector: "ytd-compact-video-renderer", label: "Sidebar recommendation", kindHints: ["Ad", "Podcast"] },
      { selector: "ytd-ad-slot-renderer", label: "Ad", kindHints: ["Ad"] },
    ],
  },
  {
    hosts: ["instagram.com"],
    groups: [
      { selector: "article", label: "Feed post", kindHints: ["Promoted post"] },
      { selector: 'a[href*="/reel/"]', label: "Reel", kindHints: ["Reel"] },
      { selector: 'main a[href*="/p/"]', label: "Post tile" },
    ],
  },
  {
    hosts: ["x.com", "twitter.com"],
    groups: [
      { selector: 'article[data-testid="tweet"]', label: "Post", kindHints: ["Promoted post"] },
      { selector: '[data-testid="trend"]', label: "Trend" },
    ],
  },
  {
    hosts: ["reddit.com"],
    groups: [
      { selector: "shreddit-post", label: "Post" },
      { selector: "shreddit-ad-post", label: "Promoted post", kindHints: ["Promoted post"] },
    ],
  },
  {
    hosts: ["tiktok.com"],
    groups: [{ selector: '[data-e2e="recommend-list-item-container"]', label: "Video" }],
  },
  {
    hosts: ["linkedin.com"],
    groups: [
      { selector: '[data-id^="urn:li:activity"]', label: "Feed post", kindHints: ["Promoted post"] },
      { selector: "div.feed-shared-update-v2", label: "Feed post (alt)", kindHints: ["Promoted post"] },
    ],
  },
  {
    hosts: ["news.ycombinator.com"],
    groups: [{ selector: "tr.athing", label: "Story" }],
  },
];
