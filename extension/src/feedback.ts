import type { SuggestionFeedback } from "../../shared/protocol.js";
import { load, save } from "./storage.js";

export const MAX_FEEDBACK = 30;

export function addFeedback(list: SuggestionFeedback[], entry: SuggestionFeedback): SuggestionFeedback[] {
  return [...list, entry].slice(-MAX_FEEDBACK);
}

export async function recordFeedback(entry: Omit<SuggestionFeedback, "at">, now = Date.now()): Promise<void> {
  const { suggestionFeedback } = await load();
  await save({ suggestionFeedback: addFeedback(suggestionFeedback, { ...entry, host: entry.host.toLowerCase(), at: now }) });
}

export async function recentFeedback(limit = 12): Promise<SuggestionFeedback[]> {
  const { suggestionFeedback } = await load();
  return limit > 0 ? suggestionFeedback.slice(-limit) : [];
}
