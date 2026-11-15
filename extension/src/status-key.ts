import type { StatusInfo } from "./messages.js";

type PaintedStatus = Pick<StatusInfo, "providers" | "activeProvider" | "notice" | "connected" | "error" | "busy" | "models" | "provider" | "available">;

export function paintedStatusKey(status: PaintedStatus): string {
  return JSON.stringify({
    providers: status.providers ?? null,
    activeProvider: status.activeProvider ?? null,
    notice: status.notice ?? null,
    connected: status.connected,
    error: status.error ?? null,
    busy: status.busy,
    models: status.models ?? null,
    provider: status.provider ?? null,
    available: status.available ?? null,
  });
}
