import type { AppliedSummary, UiEvent } from "../messages.js";

export interface RunResult {
  kind: "done" | "error" | "blocked";
  text: string;
  applied: AppliedSummary[];
}

// A reply that arrived is the outcome. A connection error before or after it must not replace it.
// A block stays a block when the explanatory done follows, so the label does not become "no changes".
export function applyRunEvent(
  run: { status: "pending" | "queued" | "running" | "done"; result?: RunResult },
  event: UiEvent,
): "drop" | "keep" {
  if (event.type === "cancelled" && (run.status === "queued" || run.status === "pending")) return "drop";
  if (event.type === "blocked") {
    if (run.result?.kind !== "done") {
      run.result = { kind: "blocked", text: `Blocked. This page tried to give the agent instructions: "${event.reason.slice(0, 90)}"`, applied: [] };
    }
  } else if (event.type === "done") {
    if (run.result?.kind !== "blocked") run.result = { kind: "done", text: event.reply || "Done.", applied: event.applied };
  } else if ((event.type === "error" || event.type === "cancelled") && run.result?.kind !== "done" && run.result?.kind !== "blocked") {
    const text = event.type === "error" ? event.message : (event.reason ?? "Stopped.");
    run.result = { kind: "error", text, applied: [] };
  }
  return "keep";
}

export function collapsedLabel(result: RunResult, awaitingPick: boolean): string {
  if (awaitingPick) return "pick an option";
  if (result.kind === "done") {
    const count = result.applied.length;
    return count ? `${count} change${count === 1 ? "" : "s"}` : "no changes";
  }
  if (result.kind === "blocked") return "blocked";
  return "stopped or failed";
}
