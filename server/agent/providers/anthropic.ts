import { llmFetch } from "../../llm-logs.js";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Tier, UsageReporter } from "../../../shared/protocol.js";
import { getKey } from "../../keys.js";
import { buildUserTurn, SYSTEM_PROMPT } from "../prompt.js";
import type { AgentSession } from "../session.js";
import { tools, type ToolOutput } from "../tools.js";
import type { AgentProvider } from "./types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

function toContent(output: ToolOutput) {
  if (!output.image) return output.text;
  return [
    { type: "text" as const, text: output.text },
    { type: "image" as const, source: { type: "base64" as const, media_type: output.image.mediaType, data: output.image.base64 } },
  ];
}

export function createAnthropicProvider(): AgentProvider {
  const client = new Anthropic({ fetch: llmFetch, apiKey: getKey("ANTHROPIC_API_KEY") });
  const models: Record<Tier, string> = {
    fast: process.env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-5-5",
    frontier: process.env.ANTHROPIC_MODEL_FRONTIER ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
  };
  const efforts: Record<Tier, Effort> = { fast: "low", frontier: (process.env.AGENT_EFFORT as Effort | undefined) ?? "medium" };

  return {
    name: "anthropic-key",
    models,
    async complete(system: string, user: string, model: string, reportUsage: UsageReporter) {
      const response = await client.messages.create({ model, max_tokens: 2000, output_config: { effort: "low" }, system, messages: [{ role: "user", content: user }] });
      reportUsage({ calls: 1, inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens });
      return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
    },
    async listModels() {
      const page = await client.models.list({ limit: 50 });
      return page.data.map((model) => model.id);
    },
    async run(session: AgentSession, tier: Tier, model: string, reportUsage: UsageReporter) {
      const runnableTools = tools.map((tool) =>
        betaZodTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.schema,
          run: async (input) => toContent(await tool.run(input, session)),
        }),
      );

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 16000,
        max_iterations: 16,
        ...(model.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        output_config: { effort: efforts[tier] },
        // Cache breakpoint after the tools and system prompt, which repeat unchanged on every turn.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: runnableTools,
        messages: [{ role: "user", content: buildUserTurn(session.request) }],
      }, { signal: session.signal });

      for await (const message of runner) {
        reportUsage({ calls: 1, inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens });
      }
      const finalMessage = await runner;
      if (finalMessage.stop_reason === "refusal") return "I can't help with that one.";
      return finalMessage.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
    },
  };
}
