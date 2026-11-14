import { AdaptResponse, VerifyResponse, type RequestBody } from "@browser-agent/shared";
import { z } from "zod";
import type { Adapter } from "../adapter";
import { buildAdaptPrompt, parseAdaptText, responseJsonSchema } from "../gemini-adapter";
import type { LlmClient } from "../llm";
import { buildPreferencePrompt, parsePreferenceText, preferenceResponseJsonSchema, type PreferenceCompiler } from "../preferences";
import { buildRequestPrompt, type Requester } from "../requester";
import { buildVerifyPrompt, type Verifier } from "../verifier";
import { responses, type InputMessage, type InputPart, type StructuredSchema } from "./client";
import { stripNulls, toStrictSchema } from "./strict-schema";

function jsonSchemaOf(type: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(type, { io: "output" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

// The adaptation union has no root object, which structured outputs reject, so it travels inside { result }.
const ADAPT_SCHEMA: StructuredSchema = {
  name: "page_adaptation",
  schema: {
    type: "object",
    properties: { result: responseJsonSchema() },
    required: ["result"],
    additionalProperties: false,
  },
};
ADAPT_SCHEMA.schema = toStrictSchema(ADAPT_SCHEMA.schema) as Record<string, unknown>;

const PREFERENCE_SCHEMA: StructuredSchema = {
  name: "preference_change",
  schema: {
    type: "object",
    properties: { result: preferenceResponseJsonSchema() },
    required: ["result"],
    additionalProperties: false,
  },
};
PREFERENCE_SCHEMA.schema = toStrictSchema(PREFERENCE_SCHEMA.schema) as Record<string, unknown>;

const VERIFY_SCHEMA: StructuredSchema = {
  name: "adaptation_verdict",
  schema: toStrictSchema(jsonSchemaOf(VerifyResponse)) as Record<string, unknown>,
};

export function unwrapResult(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { result?: unknown };
    return parsed.result === undefined ? undefined : JSON.stringify(stripNulls(parsed.result));
  } catch {
    return undefined;
  }
}

async function adaptationFromPrompt(prompt: string) {
  const text = await responses({ input: [{ role: "user", content: prompt }], schema: ADAPT_SCHEMA });
  return parseAdaptText(unwrapResult(text));
}

export const chatgptAdapter: Adapter = (req) => adaptationFromPrompt(buildAdaptPrompt(req));

export const chatgptRequester: Requester = (body: RequestBody) => adaptationFromPrompt(buildRequestPrompt(body));

export const chatgptPreferenceCompiler: PreferenceCompiler = async (req) => {
  const text = await responses({ input: [{ role: "user", content: buildPreferencePrompt(req) }], schema: PREFERENCE_SCHEMA });
  return parsePreferenceText(unwrapResult(text));
};

export const chatgptVerifier: Verifier = async (req) => {
  const parts: InputPart[] = [
    { type: "input_text", text: "Image 1 (before):" },
    { type: "input_image", image_url: req.before, detail: "auto" },
    { type: "input_text", text: "Image 2 (after):" },
    { type: "input_image", image_url: req.after, detail: "auto" },
    { type: "input_text", text: buildVerifyPrompt(req) },
  ];
  const text = await responses({ input: [{ role: "user", content: parts }], schema: VERIFY_SCHEMA });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("verifier output invalid");
  }
  const checked = VerifyResponse.safeParse(json);
  if (!checked.success) throw new Error("verifier output invalid");
  return checked.data;
};

export const chatgptLlm: LlmClient = async (req) => {
  const instructions = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const input: InputMessage[] = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const schema = req.jsonSchema ? { name: "chat_reply", schema: req.jsonSchema } : undefined;
  const text = await responses({ input, instructions: instructions || undefined, schema });
  return { text };
};
