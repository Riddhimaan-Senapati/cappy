import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  ADAPT_PATH,
  AdaptRequest,
  COMPILE_PREFERENCE_PATH,
  detectInjection,
  CompilePreferenceRequest,
  CompilePreferenceResponse,
  INJECTION_BLOCK_REASON,
  LLM_PATH,
  LlmRequest,
  LlmResponse,
  REQUEST_PATH,
  RequestBody,
  VERIFY_PATH,
  VerifyRequest,
} from "@browser-agent/shared";
import type { z } from "zod";
import type { Adapter } from "./adapter";
import { BLOCKED_ADAPTER_ERROR, guardAdaptResponse, guardContentGroups, guardSnapshotTargets } from "./guard";
import { injectionGate } from "./injection-guard";
import type { LlmClient } from "./llm";
import { PREFERENCE_UNAVAILABLE, type PreferenceCompiler, UNSAFE_PREFERENCE } from "./preferences";
import type { Requester } from "./requester";
import type { Verifier } from "./verifier";

export type AppDeps = {
  adapter: Adapter;
  llm: LlmClient;
  requester: Requester;
  verifier: Verifier;
  compilePreference: PreferenceCompiler;
};

const VERIFY_BODY_MAX = 10 * 1024 * 1024;

export function allowedOrigin(origin: string): string | null {
  const local = origin === "http://localhost" || origin.startsWith("http://localhost:");
  return origin.startsWith("chrome-extension://") || local ? origin : null;
}

async function parseBody<S extends z.ZodType>(c: Context, schema: S) {
  const raw: unknown = await c.req.json().catch(() => undefined);
  return schema.safeParse(raw);
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("*", cors({ origin: allowedOrigin }));
  app.use(
    VERIFY_PATH,
    bodyLimit({ maxSize: VERIFY_BODY_MAX, onError: (c) => c.json({ error: "payload too large" }, 413) }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post(ADAPT_PATH, async (c) => {
    const parsed = await parseBody(c, AdaptRequest);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    const gate = injectionGate(req.outline);
    if (gate) {
      console.warn("[injection] /adapt blocked before model call:", gate.evidence);
      return c.json(gate.blocked);
    }
    let raw: unknown;
    try {
      raw = await deps.adapter(req);
    } catch {
      return c.json(BLOCKED_ADAPTER_ERROR, 502);
    }
    const checked = guardAdaptResponse(raw, new URL(req.url).hostname);
    return c.json(guardContentGroups(guardSnapshotTargets(checked, req.outline.elements), req.outline.groups));
  });

  app.post(REQUEST_PATH, async (c) => {
    const parsed = await parseBody(c, RequestBody);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    const gate = injectionGate(req.outline);
    if (gate) {
      console.warn("[injection] /request blocked before model call:", gate.evidence);
      return c.json(gate.blocked);
    }
    let raw: unknown;
    try {
      raw = await deps.requester(req);
    } catch {
      return c.json(BLOCKED_ADAPTER_ERROR, 502);
    }
    const checked = guardAdaptResponse(raw, new URL(req.url).hostname);
    return c.json(guardContentGroups(guardSnapshotTargets(checked, req.outline.elements), req.outline.groups));
  });

  app.post(VERIFY_PATH, async (c) => {
    const parsed = await parseBody(c, VerifyRequest);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await deps.verifier(parsed.data));
    } catch {
      return c.json({ error: "verifier unavailable" }, 502);
    }
  });

  app.post(COMPILE_PREFERENCE_PATH, async (c) => {
    const parsed = await parseBody(c, CompilePreferenceRequest);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    if (req.need.kind !== "preference") {
      return c.json({ error: "only preference needs compile" }, 400);
    }
    const scan = detectInjection(req.need.detail);
    if (scan.flagged) {
      console.warn("[injection] /compile-preference blocked before compile:", scan.evidence);
      return c.json({ kind: "none", reason: INJECTION_BLOCK_REASON });
    }
    let raw: unknown;
    try {
      raw = await deps.compilePreference(req);
    } catch {
      return c.json(PREFERENCE_UNAVAILABLE, 502);
    }
    const checked = CompilePreferenceResponse.safeParse(raw);
    return c.json(checked.success ? checked.data : UNSAFE_PREFERENCE);
  });

  app.post(LLM_PATH, async (c) => {
    const parsed = await parseBody(c, LlmRequest);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const reply = LlmResponse.safeParse(await deps.llm(parsed.data));
    if (!reply.success) return c.json({ error: "llm output invalid" }, 502);
    return c.json(reply.data);
  });

  return app;
}
