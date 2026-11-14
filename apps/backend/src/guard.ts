import { AdaptResponse, matchesHost } from "@browser-agent/shared";

export const BLOCKED_VALIDATION: AdaptResponse = {
  kind: "blocked",
  reason: "adaptation failed validation",
};

export const BLOCKED_ADAPTER_ERROR: AdaptResponse = {
  kind: "blocked",
  reason: "adapter unavailable",
};

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
