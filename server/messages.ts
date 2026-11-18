import { z } from "zod";
import type { ClientMessage } from "../shared/protocol.js";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const id = z.string().min(1).max(200);
const tierModels = z.record(z.string(), z.string().max(200)).optional();
const lines = z.array(z.string().max(2000)).max(200);
const outline = z.looseObject({});

// Checks the fields the server reads directly. Page outlines and change lists are only required to be the right container type, since their contents are fenced as untrusted data downstream.
const schemas = {
  ping: z.looseObject({ type: z.literal("ping") }),
  toolResult: z.looseObject({ type: z.literal("toolResult"), callId: id, ok: z.boolean(), error: z.string().max(10_000).optional() }),
  cancel: z.looseObject({ type: z.literal("cancel"), runId: id }),
  listModels: z.looseObject({ type: z.literal("listModels"), provider: id }),
  chatgptLogin: z.looseObject({ type: z.literal("chatgptLogin") }),
  chatgptLogout: z.looseObject({ type: z.literal("chatgptLogout") }),
  setKey: z.looseObject({ type: z.literal("setKey"), provider: id, key: z.string().max(8192).nullable().optional(), baseURL: z.string().max(2048).nullable().optional() }),
  classify: z.looseObject({ type: z.literal("classify"), requestId: id, provider: id.optional(), models: tierModels, match: z.string().max(2000), items: z.array(z.string().max(2000)).max(2000) }),
  suggest: z.looseObject({ type: z.literal("suggest"), requestId: id, provider: id.optional(), models: tierModels, profile: lines, applied: lines, page: outline, host: z.string().max(300).optional(), friction: z.array(z.looseObject({})).max(50).optional(), feedback: z.array(z.looseObject({})).max(200).optional() }),
  run: z.looseObject({
    type: z.literal("run"),
    runId: id,
    trigger: z.enum(["chat", "page_load"]),
    message: z.string().max(20_000),
    provider: id.optional(),
    routing: z.enum(["auto", "fast", "frontier"]),
    models: tierModels,
    history: z.array(z.looseObject({})).max(50),
    profile: lines,
    siteSkill: lines.optional(),
    active: z.array(z.looseObject({})).max(2000),
    page: outline,
  }),
} as const;

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !Object.hasOwn(schemas, type)) return null;
  const result = schemas[type as keyof typeof schemas].safeParse(value);
  return result.success ? (value as ClientMessage) : null;
}
