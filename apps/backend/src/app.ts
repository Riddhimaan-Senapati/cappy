import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  ADAPT_PATH,
  AdaptRequest,
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
import { BLOCKED_ADAPTER_ERROR, guardAdaptResponse, guardSnapshotTargets } from "./guard";
import { injectionGate } from "./injection-guard";
import type { LlmClient } from "./llm";
import type { Requester } from "./requester";
import type { Verifier } from "./verifier";

export type AppDeps = { adapter: Adapter; llm: LlmClient; requester: Requester; verifier: Verifier };

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
    return c.json(guardSnapshotTargets(guardAdaptResponse(raw, new URL(req.url).hostname), req.outline.elements));
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
    return c.json(guardSnapshotTargets(guardAdaptResponse(raw, new URL(req.url).hostname), req.outline.elements));
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
