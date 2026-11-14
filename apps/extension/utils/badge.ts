import type { Profile } from "@browser-agent/shared";

const MAX_REASON = 200;
const MAX_DETAIL = 120;

export function reasonBadge(reason: string, needId: string, profile: Profile): string {
  const need = profile.needs.find((n) => n.id === needId);
  if (!need) return reason;
  const suffix = ` (because: ${need.detail.slice(0, MAX_DETAIL)})`;
  return `${reason.slice(0, MAX_REASON - suffix.length)}${suffix}`;
}
