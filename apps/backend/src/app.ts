import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ADAPT_PATH, AdaptRequest, LLM_PATH, LlmRequest, LlmResponse } from "@browser-agent/shared";
import type { z } from "zod";
import type { Adapter } from "./adapter";
import { BLOCKED_ADAPTER_ERROR, guardAdaptResponse } from "./guard";
import type { LlmClient } from "./llm";

export type AppDeps = { adapter: Adapter; llm: LlmClient };

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

  app.get("/health", (c) => c.json({ ok: true }));

  app.post(ADAPT_PATH, async (c) => {
    const parsed = await parseBody(c, AdaptRequest);
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    let raw: unknown;
    try {
      raw = await deps.adapter(req);
    } catch {
      return c.json(BLOCKED_ADAPTER_ERROR, 502);
    }
    return c.json(guardAdaptResponse(raw, new URL(req.url).hostname));
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
