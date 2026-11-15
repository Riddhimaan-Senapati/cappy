import { llmFetch } from "../../llm-logs.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import type { Tier, UsageReporter } from "../../../shared/protocol.js";
import { getKey, type KeyName } from "../../keys.js";
import { buildUserTurn, SYSTEM_PROMPT } from "../prompt.js";
import type { AgentSession } from "../session.js";
import { tools, type ToolOutput } from "../tools.js";
import type { AgentProvider } from "./types.js";

const MAX_STEPS = 16;

function modelTools(session: AgentSession) {
  return Object.fromEntries(
    tools.map((agentTool) => [
      agentTool.name,
      tool({
        description: agentTool.description,
        inputSchema: agentTool.schema,
        execute: async (input) => {
          session.throwIfCancelled();
          try {
            return await agentTool.run(agentTool.schema.parse(input), session);
          } catch (error) {
            return { text: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
        toModelOutput: ({ output }) => {
          const result = output as ToolOutput;
          if (!result.image) return { type: "text" as const, value: result.text };
          return {
            type: "content" as const,
            value: [
              { type: "text" as const, text: result.text },
              { type: "file" as const, mediaType: result.image.mediaType, data: { type: "data" as const, data: result.image.base64 } },
            ],
          };
        },
      }),
    ]),
  );
}

async function runModel(model: LanguageModel, session: AgentSession, reportUsage: UsageReporter): Promise<string> {
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildUserTurn(session.request),
    tools: modelTools(session),
    stopWhen: [isStepCount(MAX_STEPS), () => session.escalation != null, () => session.finishNote != null],
    abortSignal: session.signal,
    onStepFinish: (step) => {
      reportUsage({ calls: 1, inputTokens: step.usage.inputTokens ?? 0, outputTokens: step.usage.outputTokens ?? 0 });
      const note = step.text.trim();
      if (note) session.progress(note.length > 120 ? `${note.slice(0, 117)}...` : note);
    },
  });
  if (session.escalation) return "";
  if (session.finishNote) return session.finishNote;
  const text = result.text.trim();
  if (!text && result.finishReason === "tool-calls") return "I stopped after too many steps. Some changes may be partly applied; you can undo them in the panel.";
  return text;
}

async function completeModel(model: LanguageModel, system: string, user: string, reportUsage: UsageReporter): Promise<string> {
  const result = await generateText({ model, system, prompt: user });
  reportUsage({ calls: 1, inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0 });
  return result.text.trim();
}

async function listedModels(url: string, headers: Record<string, string>): Promise<string[]> {
  const response = await fetch(url, { headers });
  if (!response.ok) return [];
  const json = (await response.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).flatMap((model) => (model.id ? [model.id] : []));
}

export function createXaiProvider(): AgentProvider {
  const apiKey = getKey("XAI_API_KEY");
  const client = createXai({ apiKey, fetch: llmFetch });
  const models: Record<Tier, string> = {
    fast: process.env.XAI_MODEL_FAST ?? "grok-4.7",
    frontier: process.env.XAI_MODEL_FRONTIER ?? process.env.XAI_MODEL ?? "grok-4.7",
  };
  return {
    name: "xai",
    models,
    async listModels() {
      return listedModels("https://api.x.ai/v1/models", { authorization: `Bearer ${apiKey ?? ""}` });
    },
    run: (session, _tier, model, reportUsage) => runModel(client.responses(model), session, reportUsage),
    complete: (system, user, model, reportUsage) => completeModel(client.responses(model), system, user, reportUsage),
  };
}

function compatibleModels(fastEnv: string | undefined, frontierEnv: string | undefined, fastDefault: string, frontierDefault: string): Record<Tier, string> {
  return { fast: fastEnv ?? fastDefault, frontier: frontierEnv ?? fastEnv ?? frontierDefault };
}

export function createOpenAICompatibleProvider(): AgentProvider {
  const apiKey = getKey("OPENAI_COMPAT_API_KEY");
  const baseURL = getKey("OPENAI_COMPAT_BASE_URL") ?? "";
  const client = createOpenAICompatible({ name: "openai-compatible", fetch: llmFetch, apiKey, baseURL, includeUsage: true, supportsMultiPartToolContent: true });
  const models = compatibleModels(process.env.OPENAI_COMPAT_MODEL_FAST, process.env.OPENAI_COMPAT_MODEL_FRONTIER ?? process.env.OPENAI_COMPAT_MODEL, "gpt-4o-mini", "gpt-4o");
  return {
    name: "openai-compat",
    models,
    listModels: () => listedModels(`${baseURL.replace(/\/$/, "")}/models`, { authorization: `Bearer ${apiKey ?? ""}` }),
    run: (session, _tier, model, reportUsage) => runModel(client.chatModel(model), session, reportUsage),
    complete: (system, user, model, reportUsage) => completeModel(client.chatModel(model), system, user, reportUsage),
  };
}

export function createAnthropicCompatibleProvider(): AgentProvider {
  const apiKey = getKey("ANTHROPIC_COMPAT_API_KEY");
  const baseURL = getKey("ANTHROPIC_COMPAT_BASE_URL") ?? "";
  const client = createAnthropic({ apiKey, baseURL, fetch: llmFetch });
  const models = compatibleModels(process.env.ANTHROPIC_COMPAT_MODEL_FAST, process.env.ANTHROPIC_COMPAT_MODEL_FRONTIER ?? process.env.ANTHROPIC_COMPAT_MODEL, "claude-haiku-5-5", "claude-opus-5-5");
  return {
    name: "anthropic-compat",
    models,
    async listModels() {
      return listedModels(`${baseURL.replace(/\/$/, "")}/models`, { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" });
    },
    run: (session, _tier, model, reportUsage) => runModel(client(model), session, reportUsage),
    complete: (system, user, model, reportUsage) => completeModel(client(model), system, user, reportUsage),
  };
}

export function endpointDetail(baseKey: KeyName): string | undefined {
  const base = getKey(baseKey);
  if (!base) return undefined;
  try {
    return new URL(base).host;
  } catch {
    return undefined;
  }
}
