import { AdaptResponse, filtersTargetKnownGroups, matchesHost, opsTargetKnownIds } from "@browser-agent/shared";

export const BLOCKED_VALIDATION: AdaptResponse = {
  kind: "blocked",
  reason: "adaptation failed validation",
};

export const BLOCKED_ADAPTER_ERROR: AdaptResponse = {
  kind: "blocked",
  reason: "adapter unavailable",
};

export const BLOCKED_UNKNOWN_ELEMENTS: AdaptResponse = {
  kind: "blocked",
  reason: "adaptation targeted elements the page did not have",
};

export const BLOCKED_UNKNOWN_GROUPS: AdaptResponse = {
  kind: "blocked",
  reason: "adaptation targeted content groups the page did not have",
};

// A filter that names a selector not in the outline would hide nothing on the page the model saw.
export function guardContentGroups(response: AdaptResponse, groups: ReadonlyArray<{ selector: string }> | undefined): AdaptResponse {
  if (response.kind !== "adaptation") return response;
  const known = new Set((groups ?? []).map((g) => g.selector));
  return filtersTargetKnownGroups(response.adaptation, known) ? response : BLOCKED_UNKNOWN_GROUPS;
}

// Ids are only meaningful for the outline the model saw, so ops must name ids from that outline.
export function guardSnapshotTargets(response: AdaptResponse, elements: ReadonlyArray<{ id: string }> | undefined): AdaptResponse {
  if (response.kind !== "adaptation") return response;
  const known = new Set((elements ?? []).map((e) => e.id));
  return opsTargetKnownIds(response.adaptation, known) ? response : BLOCKED_UNKNOWN_ELEMENTS;
}

export function guardAdaptResponse(raw: unknown, host: string): AdaptResponse {
  const checked = AdaptResponse.safeParse(raw);
  if (!checked.success) return BLOCKED_VALIDATION;
  const response = checked.data;
  if (response.kind === "adaptation") {
    const inScope = response.adaptation.sites.every((site) => matchesHost(site, host));
    if (!inScope) return BLOCKED_VALIDATION;
  }
  return response;
}
