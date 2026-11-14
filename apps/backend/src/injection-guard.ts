import {
  INJECTION_BLOCK_REASON,
  detectInjection,
  type AdaptResponse,
  type PageOutline,
} from "@browser-agent/shared";

export const INJECTION_BLOCKED: AdaptResponse = { kind: "blocked", reason: INJECTION_BLOCK_REASON };

export function injectionGate(outline: PageOutline): { blocked: AdaptResponse; evidence: string } | null {
  const scan = detectInjection([outline.title, ...outline.headings, outline.text ?? ""].join("\n"));
  return scan.flagged ? { blocked: INJECTION_BLOCKED, evidence: scan.evidence } : null;
}
