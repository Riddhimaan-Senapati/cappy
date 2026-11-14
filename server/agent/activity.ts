import type { FrictionCount } from "../../shared/protocol.js";

// One short line per kind keeps hours of activity to a few dozen tokens.
export function describeActivity(activity: FrictionCount[] | undefined): string {
  if (!activity?.length) return "(none)";
  return activity
    .map((count) => {
      const elsewhere = count.sessionElsewhere ? `; other sites ${count.sessionElsewhere} (6h) across ${Math.max(1, count.sessionSites - (count.sessionHere ? 1 : 0))}` : "";
      return `- ${count.kind}: here ${count.here} (10m) · ${count.hourHere} (1h) · ${count.sessionHere} (6h) · ${count.totalHere} all-time${elsewhere}`;
    })
    .join("\n");
}
