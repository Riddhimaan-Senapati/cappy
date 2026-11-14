import type { Routing, TabToolName, Tier, Trigger } from "../../shared/protocol.js";
import type { VoiceEvent } from "./voice/core.js";

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
  | { type: "memory"; runId: string; status: "saved" | "proposed"; lines: string[] }
  | { type: "done"; runId: string; trigger: Trigger; reply: string; applied: AppliedSummary[]; fromCache: boolean }
  | { type: "error"; runId: string; message: string };

export type ContentRequest =
  | { kind: "tool"; name: Exclude<TabToolName, "screenshot" | "use_site_control">; input: unknown }
  | { kind: "useSiteControl"; input: unknown; userMessage: string }
  | { kind: "list" }
  | { kind: "busy"; on: boolean }
  | { kind: "toast"; text: string; undoIds: string[] }
  | { kind: "toggleSpotlight" }
  | { kind: "startVoice" }
  | { kind: "frictionSaved"; origin: string }
  | { kind: "frictionPrompt"; origin: string }
  | { kind: "ui"; event: UiEvent }
  | { kind: "readAloud" }
  | { kind: "voiceEvent"; event: VoiceEvent };

export type TtsSource = "reply" | "announce" | "page" | "test";

export type TtsRequest =
  | { type: "tts-speak"; text: string; source: TtsSource }
  | { type: "tts-stop" }
  | { type: "tts-voices" };

export type TtsStateMessage = { type: "tts-state"; speaking: boolean };

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
  | { kind: "frictionAccept" }
  | { kind: "pageReady"; origin: string; restored: number }
  | { kind: "openDebug" }
  | { kind: "openShortcuts" }
  | { kind: "status" }
  | { kind: "voiceStart"; lang: string }
  | { kind: "voiceStop" }
  | { kind: "voiceOpenMic" }
  | { kind: "recognitionEvent"; event: unknown };

export type DebugPortMessage =
  | { type: "status"; status: StatusInfo }
  | { type: "event"; tabId: number; at: number; event: UiEvent }
  | { type: "tool"; tabId: number; at: number; name: string; ms: number; ok: boolean; detail: string };

export type DebugPortRequest = { type: "chat"; message: string };

export const ROUTING_LABELS: Record<Routing, string> = { auto: "Auto", fast: "Fast", frontier: "Frontier" };
