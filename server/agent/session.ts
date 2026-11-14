import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { RunRequest, ServerMessage, TabToolName, TabTools, Tier, ToolResultMessage } from "../../shared/protocol.js";

const TOOL_TIMEOUT_MS = 15_000;

export class RunCancelledError extends Error {}

export class AgentSession {
  readonly profileUpdates: string[] = [];
  readonly appliedIds = new Set<string>();
  blockedReason: string | null = null;
  escalation: string | null = null;
  tier: Tier = "fast";
  failures = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;
  private controller = new AbortController();

  constructor(
    private socket: WebSocket,
    readonly request: RunRequest,
  ) {}

  get signal() {
    return this.controller.signal;
  }

  get cancelled() {
    return this.closed;
  }

  throwIfCancelled() {
    if (this.closed) throw new RunCancelledError("Run cancelled");
  }

  send(message: ServerMessage) {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }

  progress(text: string) {
    this.send({ type: "progress", runId: this.request.runId, text });
  }

  warn(text: string) {
    this.send({ type: "warning", runId: this.request.runId, text });
  }

  struggled() {
    return this.failures >= 2 || (this.failures >= 1 && this.appliedIds.size === 0);
  }

  async undoAppliedChanges() {
    for (const id of this.appliedIds) await this.callTab("revert_change", { id }).catch(() => undefined);
    this.appliedIds.clear();
    this.failures = 0;
  }

  callTab<Name extends TabToolName>(name: Name, input: TabTools[Name]["input"]): Promise<TabTools[Name]["output"]> {
    if (this.closed) return Promise.reject(new RunCancelledError("Extension disconnected"));
    const callId = randomUUID();
    this.send({ type: "tool", runId: this.request.runId, callId, name, input });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`Tab tool ${name} timed out`));
      }, TOOL_TIMEOUT_MS);
      this.pending.set(callId, {
        resolve: (value) => (clearTimeout(timer), resolve(value as TabTools[Name]["output"])),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
    });
  }

  handleToolResult(message: ToolResultMessage) {
    const waiter = this.pending.get(message.callId);
    if (!waiter) return;
    this.pending.delete(message.callId);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? "Tab tool failed"));
  }

  close() {
    this.closed = true;
    this.controller.abort();
    for (const waiter of this.pending.values()) waiter.reject(new RunCancelledError("Extension disconnected"));
    this.pending.clear();
  }
}
