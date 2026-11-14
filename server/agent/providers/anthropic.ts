import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
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
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
  const effort = (process.env.AGENT_EFFORT ?? "low") as Effort;

  return {
    name: "anthropic-key",
    model,
    async run(session: AgentSession) {
      const runnableTools = tools.map((tool) =>
        betaZodTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.schema,
          run: async (input) => toContent(await tool.run(input, session)),
        }),
      );

      const finalMessage = await client.beta.messages.toolRunner({
        model,
        max_tokens: 16000,
        max_iterations: 16,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort },
        system: SYSTEM_PROMPT,
        tools: runnableTools,
        messages: [{ role: "user", content: buildUserTurn(session.request) }],
      });

      if (finalMessage.stop_reason === "refusal") return "I can't help with that one.";
      return finalMessage.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
    },
  };
}
