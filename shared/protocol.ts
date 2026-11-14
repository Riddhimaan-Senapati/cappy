import type { ActiveChange, Change, ChatTurn, PageOutline, PageStats } from "./adaptation.js";

export type Trigger = "chat" | "page_load";
export type Tier = "fast" | "frontier";
export type Routing = "auto" | Tier;

export interface RunRequest {
  type: "run";
  runId: string;
  trigger: Trigger;
  message: string;
  routing: Routing;
  models?: Partial<Record<Tier, string>>;
  history: ChatTurn[];
  profile: string[];
  active: ActiveChange[];
  page: PageOutline;
  clientTime?: { iso: string; timeZone: string };
}

export interface InspectedElement {
  tag: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  attributes: Record<string, string>;
}

export interface ApplyOutcome {
  ok: boolean;
  error?: string;
  matched: Record<string, number>;
  waitingForSchedule?: boolean;
  before: PageStats;
  after: PageStats;
  note?: string;
}

export type SiteControl = { id: string; name: string } & (
  | { kind: "toggle"; on: boolean }
  | { kind: "select"; selected: number; options: { index: number; label: string }[] }
);

export interface SiteControlInput {
  controlId: string;
  value: number | boolean;
  summary: string;
  reason: string;
}

export type SiteControlOutcome =
  | { status: "applied"; change: ActiveChange }
  | { status: "already-set" }
  | { status: "unavailable"; error: string };

export interface TabTools {
  find_site_features: { input: Record<string, never>; output: SiteControl[] };
  use_site_control: { input: SiteControlInput; output: SiteControlOutcome };
  read_page: { input: Record<string, never>; output: PageOutline };
  inspect: { input: { selector: string }; output: { count: number; samples: InspectedElement[] } };
  apply_change: { input: { change: Change }; output: ApplyOutcome };
  revert_change: { input: { id: string }; output: { ok: boolean } };
  screenshot: { input: Record<string, never>; output: { dataUrl: string } };
}

export type TabToolName = keyof TabTools;

export interface ToolCallMessage {
  type: "tool";
  runId: string;
  callId: string;
  name: TabToolName;
  input: unknown;
}

export interface ToolResultMessage {
  type: "toolResult";
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type AgentEvent =
  | { type: "progress"; runId: string; text: string }
  | { type: "tier"; runId: string; tier: Tier; model: string }
  | { type: "profile"; runId: string; lines: string[] }
  | { type: "warning"; runId: string; text: string }
  | { type: "blocked"; runId: string; reason: string }
  | { type: "done"; runId: string; reply: string }
  | { type: "error"; runId: string; message: string };

export interface PingMessage {
  type: "ping";
}

export type ClientMessage = RunRequest | ToolResultMessage | PingMessage;
export type ServerMessage = ToolCallMessage | AgentEvent | { type: "hello"; provider: string; models: Record<Tier, string>; available: string[] };
