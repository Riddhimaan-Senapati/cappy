import { PageStats } from "@browser-agent/shared";

export type StatKey = keyof PageStats;
export type StatDelta = { key: StatKey; before: number; after: number };

const KEYS = Object.keys(PageStats.shape) as StatKey[];

export function problemTotal(stats: PageStats): number {
  return KEYS.reduce((sum, key) => sum + stats[key], 0);
}

export function statsDeltas(before: PageStats, after: PageStats): StatDelta[] {
  return KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    before: before[key],
    after: after[key],
  }));
}

const LABELS: Record<StatKey, string> = {
  inputsWithoutLabel: "unlabeled inputs",
  smallTargets: "small targets",
  smallText: "small text",
  lowContrastText: "low-contrast text",
  imagesWithoutAlt: "images without alt",
  runningAnimations: "running animations",
  visibleAdsOrPopups: "visible ads or popups",
};

// Compact, human-readable line for a prompt, e.g. "small text 12, unlabeled inputs 2".
export function describeStats(stats: PageStats): string {
  return KEYS.map((key) => `${LABELS[key]} ${stats[key]}`).join(", ");
}
