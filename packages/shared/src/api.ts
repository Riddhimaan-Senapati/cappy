import { z } from "zod";
import { Adaptation } from "./adaptation";
import { Profile } from "./profile";

export const PageOutline = z
  .object({
    title: z.string().max(200),
    headings: z.array(z.string().max(120)).max(30),
    forms: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    videos: z.number().int().nonnegative(),
    canvases: z.number().int().nonnegative(),
  })
  .strict();
export type PageOutline = z.infer<typeof PageOutline>;

export const AdaptRequest = z
  .object({ url: z.url({ protocol: /^https?$/ }), outline: PageOutline, profile: Profile })
  .strict();
export type AdaptRequest = z.infer<typeof AdaptRequest>;

export const AdaptResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adaptation"), adaptation: Adaptation }).strict(),
  z.object({ kind: z.literal("none"), reason: z.string().max(200) }).strict(),
  z.object({ kind: z.literal("blocked"), reason: z.string().max(200) }).strict(),
]);
export type AdaptResponse = z.infer<typeof AdaptResponse>;

export const ChatRole = z.enum(["system", "user", "assistant"]);
export const LlmRequest = z
  .object({
    messages: z.array(z.object({ role: ChatRole, content: z.string().max(8000) }).strict()).min(1).max(60),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LlmRequest = z.infer<typeof LlmRequest>;
export const LlmResponse = z.object({ text: z.string() }).strict();
export type LlmResponse = z.infer<typeof LlmResponse>;

export const ADAPT_PATH = "/adapt";
export const LLM_PATH = "/llm";
export const DEFAULT_BACKEND_URL = "http://localhost:8787";
