import type { ActiveChange, PageOutline } from "../../shared/adaptation.js";
import type { ChoiceOption, FrictionCount, FrictionKind, MemoryScope, ProviderInfo, Routing, TabToolName, TargetElement, Tier, TokenUsage, Trigger } from "../../shared/protocol.js";
import type { VoiceEvent } from "./voice/core.js";

export interface AppliedSummary {
  id: string;
  summary: string;
  reason: string;
  scope: "site" | "everywhere";
}

export type UiEvent =
  | { type: "start"; runId: string; trigger: Trigger; message: string; thread?: string }
  | { type: "queued"; runId: string; message: string; thread?: string }
  | { type: "cancelled"; runId: string; reason?: string }
  | { type: "step"; runId: string; text: string; tone: "info" | "good" | "warn" | "bad" }
  | { type: "tier"; runId: string; tier: Tier; model: string }
  | { type: "blocked"; runId: string; reason: string }
  | { type: "options"; runId: string; question: string; options: ChoiceOption[] }
  | { type: "memory"; runId: string; status: "saved" | "proposed"; lines: string[]; host?: string; scope?: MemoryScope }
  | { type: "done"; runId: string; trigger: Trigger; reply: string; applied: AppliedSummary[]; fromCache: boolean }
  | { type: "error"; runId: string; message: string };

export interface PageInspection {
  url: string;
  loadedAt: number;
  engine: { observing: boolean; liveChanges: number };
  usage: TokenUsage;
  changes: Array<{ change: ActiveChange; source: string }>;
  activity: Array<{ at: number; text: string }>;
}

export type ContentRequest =
  | { kind: "tool"; name: Exclude<TabToolName, "screenshot" | "use_site_control">; input: unknown; source?: "llm" | "recipe" }
  | { kind: "useSiteControl"; input: unknown; userMessage: string }
  | { kind: "list" }
  | { kind: "inspectPage" }
  | { kind: "activity"; text: string }
  | { kind: "usage"; usage: TokenUsage; model: string; purpose: string }
  | { kind: "busy"; on: boolean }
  | { kind: "toast"; text: string; undoIds: string[] }
  | { kind: "toggleSpotlight" }
  | { kind: "startVoice" }
  | { kind: "targetContextElement" }
  | { kind: "pickElement" }
  | { kind: "ui"; event: UiEvent }
  | { kind: "readAloud" }
  | { kind: "voiceEvent"; event: VoiceEvent }
  | { kind: "frictionEvent"; event: FrictionKind };

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
  providers?: ProviderInfo[];
  activeProvider?: string | null;
  provider?: string;
  models?: Record<Tier, string>;
  available?: string[];
  notice?: { level: "info" | "error"; text: string };
  error?: string;
}

export type BackgroundRequest =
  | { kind: "runChat"; message: string; fresh: boolean; interrupt?: boolean; thread?: string; target?: TargetElement }
  | { kind: "deleteRequest"; message: string }
  | { kind: "pageReady"; origin: string; restored: number }
  | { kind: "openDebug" }
  | { kind: "openShortcuts" }
  | { kind: "verifyVoice"; key: string; provider?: "openai" | "gemini" }
  | { kind: "status" }
  | { kind: "setKey"; provider: string; key: string | null }
  | { kind: "chatgptLogin" }
  | { kind: "chatgptLogout" }
  | { kind: "stopRun" }
  | { kind: "suggest"; page: PageOutline; applied: string[]; friction?: FrictionCount[] }
  | { kind: "dequeue"; runId: string }
  | { kind: "voiceStart"; lang: string; hold?: boolean }
  | { kind: "voiceStop" }
  | { kind: "voiceOpenMic" }
  | { kind: "voicePermissionGranted" }
  | { kind: "recognitionEvent"; event: unknown };

export type DebugPortMessage =
  | { type: "inspection"; snapshot?: PageInspection; error?: string }
  | { type: "status"; status: StatusInfo }
  | { type: "event"; tabId: number; at: number; event: UiEvent }
  | { type: "tool"; tabId: number; at: number; name: string; ms: number; ok: boolean; detail: string };

export type DebugPortRequest = { type: "chat"; message: string; thread?: string } | { type: "inspect" };

export const ROUTING_LABELS: Record<Routing, string> = { auto: "Auto", fast: "Fast", frontier: "Pro" };
