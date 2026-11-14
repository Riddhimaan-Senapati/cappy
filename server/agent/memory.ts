import type { RunRequest } from "../../shared/protocol.js";

// Integration point for the memory system. Replace these bodies to plug in long-term memory
// (learned preferences, friction signals, Sentient notes); the agent loop only calls these two.

export async function recallForRun(request: RunRequest): Promise<string[]> {
  return request.profile;
}

export async function rememberFacts(_request: RunRequest, _lines: string[]): Promise<void> {
  // The extension already stores these lines in its profile; a memory backend can persist them here too.
}
