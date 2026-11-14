import type { Routing, TabToolName, Tier, Trigger } from "../../shared/protocol.js";

export interface AppliedSummary {
  id: string;
  summary: string;
  reason: string;
  scope: "site" | "everywhere";
}

export type UiEvent =
  | { type: "start"; runId: string; trigger: Trigger; message: string }
  | { type: "step"; runId: string; text: string; tone: "info" | "good" | "warn" | "bad" }
  | { type: "tier"; runId: string; tier: Tier; model: string }
  | { type: "blocked"; runId: string; reason: string }
  | { type: "done"; runId: string; trigger: Trigger; reply: string; applied: AppliedSummary[]; fromCache: boolean }
  | { type: "error"; runId: string; message: string };

export type ContentRequest =
  | { kind: "tool"; name: Exclude<TabToolName, "screenshot">; input: unknown }
  | { kind: "list" }
  | { kind: "busy"; on: boolean }
  | { kind: "toast"; text: string; undoIds: string[] }
  | { kind: "toggleSpotlight" }
  | { kind: "ui"; event: UiEvent };

export type ContentResponse = { ok: true; result: unknown } | { ok: false; error: string };

export interface StatusInfo {
  connected: boolean;
  busy: boolean;
  provider?: string;
  models?: Record<Tier, string>;
  available?: string[];
  error?: string;
}

export type BackgroundRequest =
  | { kind: "runChat"; message: string; fresh: boolean }
  | { kind: "pageReady"; origin: string; restored: number }
  | { kind: "openDebug" }
  | { kind: "openShortcuts" }
  | { kind: "status" };

export type DebugPortMessage =
  | { type: "status"; status: StatusInfo }
  | { type: "event"; tabId: number; at: number; event: UiEvent }
  | { type: "tool"; tabId: number; at: number; name: string; ms: number; ok: boolean; detail: string };

export type DebugPortRequest = { type: "chat"; message: string };

export const ROUTING_LABELS: Record<Routing, string> = { auto: "Auto", fast: "Fast", frontier: "Frontier" };
