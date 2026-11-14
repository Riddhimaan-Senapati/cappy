import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { z } from "zod";
import type { Tier } from "../../../shared/protocol.js";
import { getKey } from "../../keys.js";
import { buildUserTurn, SYSTEM_PROMPT } from "../prompt.js";
import type { AgentSession } from "../session.js";
import { tools } from "../tools.js";
import type { AgentProvider } from "./types.js";

const MAX_STEPS = 16;

export function createGeminiProvider(): AgentProvider {
  const ai = new GoogleGenAI({ apiKey: getKey("GEMINI_API_KEY") });
  const fast = process.env.GEMINI_MODEL_FAST ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const models: Record<Tier, string> = { fast, frontier: process.env.GEMINI_MODEL_FRONTIER ?? fast };
  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: z.toJSONSchema(tool.schema),
  }));

  return {
    name: "gemini",
    models,
    async complete(system: string, user: string, model: string) {
      const response = await ai.models.generateContent({ model, contents: user, config: { systemInstruction: system } });
      return (response.text ?? "").trim();
    },
    async listModels() {
      const names: string[] = [];
      for await (const model of await ai.models.list()) if (model.name) names.push(model.name.replace(/^models\//, ""));
      return names.filter((name) => name.startsWith("gemini"));
    },
    async run(session: AgentSession, _tier: Tier, model: string) {
      const contents: Content[] = [{ role: "user", parts: [{ text: buildUserTurn(session.request) }] }];

      for (let step = 0; step < MAX_STEPS; step++) {
        session.throwIfCancelled();
        const response = await ai.models.generateContent({
          model,
          contents,
          config: { abortSignal: session.signal, systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations }] },
        });

        const calls = response.functionCalls ?? [];
        if (!calls.length) return (response.text ?? "").trim();

        contents.push(response.candidates?.[0]?.content ?? { role: "model", parts: calls.map((functionCall) => ({ functionCall })) });

        const parts: Part[] = [];
        for (const call of calls) {
          const tool = tools.find((candidate) => candidate.name === call.name);
          let output: string;
          try {
            if (!tool) throw new Error(`Unknown tool ${call.name}`);
            const result = await tool.run(tool.schema.parse(call.args ?? {}), session);
            output = result.text;
            if (result.image) parts.push({ inlineData: { mimeType: result.image.mediaType, data: result.image.base64 } });
          } catch (error) {
            output = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
          parts.unshift({ functionResponse: { id: call.id, name: call.name, response: { output } } });
        }
        contents.push({ role: "user", parts });
        if (session.escalation) return "";
      }
      return "I stopped after too many steps. Some changes may be partly applied; you can undo them in the panel.";
    },
  };
}
