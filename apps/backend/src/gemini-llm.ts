import { GoogleGenAI, type Content } from "@google/genai";
import type { LlmRequest } from "@browser-agent/shared";
import type { LlmClient } from "./llm";

export function toContents(req: LlmRequest): Content[] {
  return req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
}

export function systemInstruction(req: LlmRequest): string | undefined {
  const text = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  return text || undefined;
}

export function geminiLlm(apiKey: string, model: string): LlmClient {
  const ai = new GoogleGenAI({ apiKey });
  return async (req) => {
    const res = await ai.models.generateContent({
      model,
      contents: toContents(req),
      config: {
        systemInstruction: systemInstruction(req),
        ...(req.jsonSchema
          ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema }
          : {}),
      },
    });
    return { text: res.text ?? "" };
  };
}
