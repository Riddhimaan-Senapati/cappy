import type { ActiveChange, Change, ChatTurn, PageOutline, PageStats } from "./adaptation.js";

export interface TokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export type UsageReporter = (usage: TokenUsage) => void;

export type Trigger = "chat" | "page_load";
export type Tier = "fast" | "frontier";
export type Routing = "auto" | Tier;

export interface TargetElement {
  selector: string;
  label: string;
  text: string;
  styles?: Record<string, string>;
}

export interface ChoiceOption {
  label: string;
  request: string;
}

export interface RunRequest {
  type: "run";
  runId: string;
  trigger: Trigger;
  message: string;
  provider?: string;
  target?: TargetElement;
  routing: Routing;
  models?: Partial<Record<Tier, string>>;
  history: ChatTurn[];
  profile: string[];
  // Notes earlier sessions saved about navigating this hostname. Derived from page content, so untrusted.
  siteSkill?: string[];
  activity?: FrictionCount[];
  active: ActiveChange[];
  page: PageOutline;
  clientTime?: { iso: string; timeZone: string };
}

export type MemoryScope = "site" | "everywhere";

export interface InspectedElement {
  tag: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  attributes: Record<string, string>;
}

export interface ContrastIssue {
  selector: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
}

export interface ApplyOutcome {
  ok: boolean;
  error?: string;
  matched: Record<string, number>;
  waitingForSchedule?: boolean;
  lowContrast?: ContrastIssue[];
  replaced?: string[];
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
  list_items: { input: { selector: string; keySelector: string | null }; output: { count: number; items: Array<{ key: string; text: string }> } };
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
  | { type: "profile"; runId: string; lines: string[]; scope: MemoryScope }
  | { type: "siteSkill"; runId: string; notes: string[] }
  | { type: "warning"; runId: string; text: string }
  | { type: "blocked"; runId: string; reason: string }
  | { type: "options"; runId: string; question: string; options: ChoiceOption[] }
  | { type: "done"; runId: string; reply: string }
  | { type: "error"; runId: string; message: string };

export interface PingMessage {
  type: "ping";
}

export interface ProviderInfo {
  id: string;
  label: string;
  setup: "key" | "signin" | "endpoint";
  ready: boolean;
  detail?: string;
  models?: Record<Tier, string>;
  available?: string[];
}

export interface SetKeyMessage {
  type: "setKey";
  provider: string;
  key: string | null;
  baseURL?: string | null;
}

export interface ListModelsMessage {
  type: "listModels";
  provider: string;
}

export interface SignInMessage {
  type: "chatgptLogin";
}

export interface SignOutMessage {
  type: "chatgptLogout";
}

// Friction the extension noticed: counts from the last few minutes, never page text.
export type FrictionKind = "zoom-in" | "pinch-zoom" | "missed-click" | "rage-click";

// Aggregated counts only. here/elsewhere/sites cover about the last 10 minutes; the rest are longer windows.
export interface FrictionCount {
  kind: FrictionKind;
  here: number;
  elsewhere: number;
  sites: number;
  hourHere: number;
  sessionHere: number;
  sessionElsewhere: number;
  sessionSites: number;
  totalHere: number;
}


export type FeedbackOutcome = "accepted-site" | "accepted-everywhere" | "accepted" | "dismissed" | "undone";

export interface SuggestionFeedback {
  text: string;
  host: string;
  outcome: FeedbackOutcome;
  at: number;
}

// text is the request to run, phrased as the user would type it; memory is the lasting preference line to propose, or null for a one-off.
export interface Suggestion {
  text: string;
  reason: string;
  scope: MemoryScope;
  memory: string | null;
}

export interface ClassifyMessage {
  type: "classify";
  requestId: string;
  provider?: string;
  models?: Partial<Record<Tier, string>>;
  match: string;
  items: string[];
}

export interface SuggestMessage {
  type: "suggest";
  requestId: string;
  provider?: string;
  models?: Partial<Record<Tier, string>>;
  profile: string[];
  applied: string[];
  page: PageOutline;
  host?: string;
  friction?: FrictionCount[];
  feedback?: SuggestionFeedback[];
}

export interface CancelMessage {
  type: "cancel";
  runId: string;
}

export type ClientMessage = RunRequest | ToolResultMessage | PingMessage | CancelMessage | SetKeyMessage | SignInMessage | SignOutMessage | ListModelsMessage | SuggestMessage | ClassifyMessage;
export type ServerMessage =
  | ToolCallMessage
  | { type: "usage"; usage: TokenUsage; runId?: string; requestId?: string; model: string }
  | AgentEvent
  | { type: "providers"; providers: ProviderInfo[]; defaultProvider: string | null }
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "suggestion"; requestId: string; suggestion: Suggestion | null }
  | { type: "classified"; requestId: string; verdicts: boolean[] | null };
