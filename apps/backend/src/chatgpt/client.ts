import { accessToken as signedInAccessToken, refreshCredentials, RESOURCE } from "./auth";

export const DEFAULT_MODEL = "gpt-6.1-sol";
const RESPONSES_URL = `${RESOURCE}/responses`;
const MODELS_URL = `${RESOURCE}/models`;
const PLAN_LIMIT_CODE = "subscription_sharing_usage";

export type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };

export interface InputMessage {
  role: "system" | "user" | "assistant";
  content: string | InputPart[];
}

export interface StructuredSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface ResponsesParams {
  input: InputMessage[];
  instructions?: string;
  schema?: StructuredSchema;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ClientDeps {
  accessToken: () => Promise<string>;
  refreshToken: () => Promise<string>;
  model: (token: string) => Promise<string>;
  fetch: FetchLike;
}

interface StreamEvent {
  type?: string;
  delta?: string;
  message?: string;
  response?: { output?: unknown; error?: { code?: string; message?: string } | null };
}

interface OutputItem {
  type?: string;
  content?: { type?: string; text?: string }[];
}

export function strictCompatible(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(strictCompatible);
  if (!node || typeof node !== "object") return true;
  const object = node as Record<string, unknown>;
  if (object.type === "object" && object.properties && typeof object.properties === "object") {
    const keys = Object.keys(object.properties);
    const required = Array.isArray(object.required) ? object.required : [];
    if (object.additionalProperties !== false || keys.some((key) => !required.includes(key))) return false;
  }
  return Object.values(object).every(strictCompatible);
}

export function buildResponsesBody(model: string, params: ResponsesParams): Record<string, unknown> {
  const body: Record<string, unknown> = { model, input: params.input, store: false, stream: true };
  if (params.instructions) body.instructions = params.instructions;
  if (params.schema) {
    const schema = { ...params.schema.schema };
    delete schema.$schema;
    body.text = {
      format: {
        type: "json_schema",
        name: params.schema.name,
        schema,
        strict: strictCompatible(schema),
      },
    };
  }
  return body;
}

function failureMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (error?.code?.includes(PLAN_LIMIT_CODE)) {
    return "ChatGPT plan limit reached. Wait for it to reset or set LLM_PROVIDER to another provider.";
  }
  return error?.message || "ChatGPT could not complete the request.";
}

function outputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const text = (output as OutputItem[])
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content ?? [])
    .flatMap((part) => (part?.type === "output_text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
  return text || undefined;
}

export function collectOutput(sse: string): string {
  let streamed = "";
  let finalText: string | undefined;
  let completed = false;
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data) as StreamEvent;
    switch (event.type) {
      case "response.output_text.delta":
        streamed += event.delta ?? "";
        break;
      case "response.completed":
        completed = true;
        finalText = outputText(event.response?.output);
        break;
      case "response.failed":
        throw new Error(failureMessage(event.response?.error));
      case "response.incomplete":
        throw new Error("ChatGPT stopped before finishing the response.");
      case "error":
        throw new Error(event.message || "ChatGPT returned a stream error.");
    }
  }
  if (!completed) throw new Error("ChatGPT stream ended before the response completed.");
  return streamed || finalText || "";
}

export async function chooseModel(
  token: string,
  configured: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  try {
    const response = await fetchImpl(MODELS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { models?: { slug?: unknown; visibility?: unknown }[] };
    const listed = body.models?.find((model) => model.visibility === "list" && typeof model.slug === "string");
    if (typeof listed?.slug === "string") return listed.slug;
    throw new Error("no listed models");
  } catch (error) {
    console.warn(`[chatgpt] could not read the model list (${error instanceof Error ? error.message : String(error)}); using ${DEFAULT_MODEL}`);
    return DEFAULT_MODEL;
  }
}

let chosenModel: Promise<string> | undefined;

const defaultDeps: ClientDeps = {
  accessToken: signedInAccessToken,
  refreshToken: async () => (await refreshCredentials()).access_token,
  model: (token) => (chosenModel ??= chooseModel(token, process.env.CHATGPT_MODEL, fetch)),
  fetch,
};

async function httpFailure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  let detail: { code?: string; message?: string } | undefined;
  try {
    detail = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
  } catch {
    detail = undefined;
  }
  const reason = detail ? failureMessage(detail) : "";
  return new Error(`ChatGPT request failed (${response.status})${reason ? `: ${reason}` : ""}`);
}

export async function responses(params: ResponsesParams, deps: ClientDeps = defaultDeps): Promise<string> {
  const send = async (token: string) => {
    const model = await deps.model(token);
    return deps.fetch(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildResponsesBody(model, params)),
      signal: AbortSignal.timeout(120_000),
    });
  };

  let response = await send(await deps.accessToken());
  if (response.status === 401) response = await send(await deps.refreshToken());
  if (!response.ok) throw await httpFailure(response);
  return collectOutput(await response.text());
}
