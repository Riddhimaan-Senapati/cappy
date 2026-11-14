import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { z } from "zod";
import { buildUserTurn, SYSTEM_PROMPT } from "../prompt.js";
import type { AgentSession } from "../session.js";
import { tools } from "../tools.js";
import type { AgentProvider } from "./types.js";

const MAX_STEPS = 16;

export function createGeminiProvider(): AgentProvider {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: z.toJSONSchema(tool.schema),
  }));

  return {
    name: "gemini",
    model,
    async run(session: AgentSession) {
      const contents: Content[] = [{ role: "user", parts: [{ text: buildUserTurn(session.request) }] }];

      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations }] },
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
      }
      return "I stopped after too many steps. Some changes may be partly applied; you can undo them in the panel.";
    },
  };
}
