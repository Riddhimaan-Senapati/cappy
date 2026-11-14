import type { TokenUsage } from "../../../shared/protocol.js";
import type { PageInspection, UiEvent } from "../messages.js";
import { activeChanges, engineStatus } from "./engine.js";

const loadedAt = Date.now();
const sources = new Map<string, string>();
const activity: PageInspection["activity"] = [];
const usage: TokenUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
let tracking = true;

export function setEventTracking(on: boolean) {
  tracking = on;
  if (!on) activity.length = 0;
}

export function recordActivity(text: string) {
  if (!tracking) return;
  activity.push({ at: Date.now(), text });
  if (activity.length > 100) activity.shift();
}

recordActivity("Extension content script loaded: dist/content.js.");

export function recordChange(id: string, source: string) {
  sources.set(id, source);
  recordActivity(`Applied ${id}: ${source}.`);
}

export function recordUsage(delta: TokenUsage, model: string, purpose: string) {
  usage.calls += delta.calls;
  usage.inputTokens += delta.inputTokens;
  usage.outputTokens += delta.outputTokens;
  recordActivity(`LLM response · ${purpose} · ${model} · ${delta.inputTokens.toLocaleString("en-US")} input / ${delta.outputTokens.toLocaleString("en-US")} output tokens.`);
}

export function recordRun(event: UiEvent) {
  if (event.type === "start") recordActivity(`Request started (${event.trigger === "page_load" ? "automatic page adaptation" : "chat"}): ${event.message || "Check page against profile"}.`);
  if (event.type === "tier") recordActivity(`Selected ${event.tier} model: ${event.model}.`);
  if (event.type === "done") {
    if (event.fromCache) for (const change of event.applied) sources.set(change.id, "Saved recipe replayed locally (no LLM call)");
    recordActivity(event.fromCache ? "Request finished using a saved recipe; no LLM call." : "Agent request finished.");
  }
  if (event.type === "error") recordActivity(`Request failed: ${event.message}`);
  if (event.type === "cancelled") recordActivity("Request cancelled.");
}

export function inspectPage(): PageInspection {
  return {
    url: location.href, loadedAt, engine: engineStatus(), usage: { ...usage },
    changes: activeChanges().map((change) => ({ change, source: sources.get(change.id) ?? "Source unavailable" })),
    activity: [...activity],
  };
}
