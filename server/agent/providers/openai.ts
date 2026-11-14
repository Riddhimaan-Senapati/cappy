import { getKey } from "../../keys.js";
import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import type { Tier } from "../../../shared/protocol.js";
import { getAccessToken, refreshCredentials } from "../../auth/chatgpt.js";
import { buildUserTurn, SYSTEM_PROMPT } from "../prompt.js";
import type { AgentSession } from "../session.js";
import { tools } from "../tools.js";
import type { AgentProvider } from "./types.js";

const MAX_STEPS = 16;
const NAMESPACE = "page";

const namespaceTool = {
  type: "namespace" as const,
  name: NAMESPACE,
  description: "Tools that read and adapt the user's current browser tab.",
  tools: tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema),
  })),
};

async function runLoop(getClient: () => Promise<OpenAI>, model: string, session: AgentSession): Promise<string> {
  const input: ResponseInputItem[] = [{ role: "user", content: buildUserTurn(session.request) }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const client = await getClient();
    // store:false + stream:true are required by the ChatGPT plan route; harmless with an API key.
    const stream = await client.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input,
      tools: [namespaceTool],
      store: false,
      stream: true,
    });

    let output: ResponseOutputItem[] | null = null;
    for await (const event of stream) {
      if (event.type === "response.completed") output = event.response.output;
      if (event.type === "response.failed") throw new Error(event.response.error?.message ?? "Response failed");
      if (event.type === "error") throw new Error(event.message);
    }
    if (!output) throw new Error("Stream ended without response.completed");

    const calls = output.filter((item) => item.type === "function_call");
    if (!calls.length) {
      return output
        .flatMap((item) => (item.type === "message" ? item.content : []))
        .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
        .join("\n")
        .trim();
    }

    input.push(...(output as ResponseInputItem[]));
    for (const call of calls) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      let result: ResponseInputItem.FunctionCallOutput["output"];
      try {
        if (!tool) throw new Error(`Unknown tool ${call.name}`);
        const outcome = await tool.run(tool.schema.parse(JSON.parse(call.arguments || "{}")), session);
        result = outcome.image
          ? [
              { type: "input_text", text: outcome.text },
              { type: "input_image", image_url: `data:${outcome.image.mediaType};base64,${outcome.image.base64}`, detail: "auto" },
            ]
          : outcome.text;
      } catch (error) {
        result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
  return "I stopped after too many steps. Some changes may be partly applied; you can undo them in the panel.";
}

export function createOpenAIKeyProvider(): AgentProvider {
  const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
  const models: Record<Tier, string> = {
    fast: process.env.OPENAI_MODEL_FAST ?? "gpt-6-luna",
    frontier: process.env.OPENAI_MODEL_FRONTIER ?? process.env.OPENAI_MODEL ?? "gpt-6.1-sol",
  };
  return {
    name: "openai-key",
    models,
    async listModels() {
      const names: string[] = [];
      for await (const model of client.models.list()) names.push(model.id);
      return names.filter((name) => name.startsWith("gpt"));
    },
    run: (session, _tier, model) => runLoop(async () => client, model, session),
  };
}

export function createChatGptProvider(): AgentProvider {
  const models: Record<Tier, string> = {
    fast: process.env.CHATGPT_MODEL_FAST ?? "gpt-6-luna",
    frontier: process.env.CHATGPT_MODEL_FRONTIER ?? process.env.CHATGPT_MODEL ?? "gpt-6.1-sol",
  };
  let retriedAuth = false;
  const getClient = async () => new OpenAI({ apiKey: await getAccessToken(), baseURL: "https://api.openai.com/v1", maxRetries: 0 });

  return {
    name: "chatgpt-signin",
    models,
    async listModels() {
      const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${await getAccessToken()}` } });
      const json = (await response.json()) as { models?: Array<{ slug: string; visibility?: string }> };
      return (json.models ?? []).filter((model) => model.visibility === "list").map((model) => model.slug);
    },
    async run(session, _tier, model) {
      try {
        return await runLoop(getClient, model, session);
      } catch (error) {
        if (error instanceof OpenAI.AuthenticationError && !retriedAuth) {
          retriedAuth = true;
          await refreshCredentials();
          return runLoop(getClient, model, session);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/subscription_sharing_usage/.test(message)) throw new Error("ChatGPT plan limit reached. Switch LLM_PROVIDER or wait for the limit to reset.");
        throw error;
      } finally {
        retriedAuth = false;
      }
    },
  };
}
