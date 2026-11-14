import type { TabToolName } from "../../shared/protocol.js";

export type ContentRequest =
  | { kind: "tool"; name: Exclude<TabToolName, "screenshot">; input: unknown }
  | { kind: "list" }
  | { kind: "busy"; on: boolean }
  | { kind: "toast"; text: string; undoIds: string[] }
  | { kind: "pause"; paused: boolean };

export type ContentResponse = { ok: true; result: unknown } | { ok: false; error: string };

export type ContentEvent = { kind: "changesUpdated"; origin: string } | { kind: "pageReady"; origin: string; restored: number };
