import { Router } from "express";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { loggingEnabled } from "./llm-logs.js";

const directory = new URL("../llm_logs/", import.meta.url);
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

// Provider wire formats differ; present their conversation parts in one small format.
export function conversation(value: any): any[] {
  if (!value) return [];
  if (typeof value === "string") return [{ kind: "text", text: value }];
  if (Array.isArray(value)) return value.flatMap(conversation);
  if (value.functionCall || value.type === "function_call" || value.type === "tool_use") {
    const call = value.functionCall ?? value;
    return [{ kind: "tool", name: call.name, input: call.args ?? call.input ?? call.arguments }];
  }
  if (value.functionResponse || value.type === "function_call_output" || value.type === "tool_result") {
    const result = value.functionResponse ?? value;
    return [{ kind: "result", name: result.name ?? result.call_id ?? result.tool_use_id ?? "Tool result", text: result.response ?? result.output ?? result.content }];
  }
  const image = value.inlineData ?? value.source;
  if (image || value.type === "input_image" || value.type === "image_url") {
    const source = image?.data ?? value.image_url?.url ?? value.image_url;
    return [{ kind: "image", source, available: typeof source === "string" && /^(\/api\/llm-logs\/images\/|data:image\/(png|jpeg|webp);base64,)/.test(source) }];
  }
  if (value.tool_calls) return [...conversation(value.content), ...value.tool_calls.flatMap((call: any) => [{ kind: "tool", name: call.function?.name, input: call.function?.arguments }])];
  if (value.role === "tool") return [{ kind: "result", name: value.name ?? value.tool_call_id ?? "Tool result", text: value.content }];
  if (typeof value.text === "string") return [{ kind: value.thought ? "thought" : "text", text: value.text }];
  if (value.error) return [{ kind: "error", text: typeof value.error === "string" ? value.error : JSON.stringify(value.error) }];
  return conversation(value.parts ?? value.content ?? value.message ?? value.output ?? value.candidates?.map((c: any) => c.content) ?? value.choices?.map((c: any) => c.message));
}

export function describeLog(data: any, id: string) {
  const request = data.request ?? {};
  const messages = request.contents ?? request.messages ?? request.input ?? [];
  const first = Array.isArray(messages) ? messages[0] : messages;
  const initial = conversation(first).filter((part) => part.kind === "text").map((part) => part.text).join("\n");
  const prompt = initial.match(/<user_message>([\s\S]*?)<\/user_message>/)?.[1]?.trim()
    || initial.match(/<needs>([\s\S]*?)<\/needs>/)?.[1]?.trim()
    || initial.trim() || "Background request";
  const response = conversation(data.response);
  const tools = response.filter((part) => part.kind === "tool").map((part) => part.name);
  const text = response.filter((part) => part.kind === "text" || part.kind === "error").map((part) => part.text).join("\n");
  const usage = data.response?.usageMetadata ?? data.response?.usage ?? {};
  return {
    id, at: id.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3"),
    group: id.match(/--run-([a-f0-9]+)/)?.[1] ?? fingerprint(initial),
    prompt, depth: Array.isArray(messages) ? messages.length : 1,
    model: request.model ?? data.response?.modelVersion ?? data.response?.model ?? "Unknown model",
    kind: response.some((p) => p.kind === "error") ? "error" : tools.length ? "tool" : "reply",
    tools, summary: text.slice(0, 240),
    inputTokens: usage.promptTokenCount ?? usage.input_tokens ?? usage.prompt_tokens ?? 0,
    outputTokens: usage.candidatesTokenCount ?? usage.output_tokens ?? usage.completion_tokens ?? 0,
  };
}

async function load(id: string) {
  if (!/^[\w.-]+\.ya?ml$/.test(id)) throw new Error("Invalid log name");
  return parse(await readFile(new URL(id, directory), "utf8"));
}

export const logViewer = Router();
// Saved prompts and screenshots hold page content, so only the developer's own browser on localhost may read them, and only while logging is on.
logViewer.use(["/api/llm-logs", "/llm-logs"], (req, res, next) => {
  const site = req.headers["sec-fetch-site"];
  if (!loggingEnabled() || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "") || req.headers.origin || (site && site !== "same-origin" && site !== "none")) return void res.sendStatus(404);
  next();
});
logViewer.get("/api/llm-logs", async (_req, res) => {
  const files = (await readdir(directory).catch(() => [])).filter((file) => /\.ya?ml$/.test(file)).sort();
  const logs = await Promise.all(files.map(async (id) => {
    try { return describeLog(await load(id), id); }
    catch { return { id, kind: "error", prompt: "Could not read log", summary: "Invalid or incomplete YAML", group: id }; }
  }));
  res.set("Cache-Control", "no-store").json(logs);
});
logViewer.get("/api/llm-logs/images/:name", async (req, res) => {
  if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(req.params.name)) return void res.sendStatus(404);
  const path = fileURLToPath(new URL(`images/${req.params.name}`, directory));
  try { await stat(path); res.sendFile(path); } catch { res.sendStatus(404); }
});
logViewer.get("/api/llm-logs/:id", async (req, res) => {
  try {
    const data = await load(req.params.id);
    const request = data.request ?? {};
    const messages = request.contents ?? request.messages ?? request.input ?? [];
    const parts = conversation(messages);
    // New tool results are after the most recent assistant/model turn.
    let start = Array.isArray(messages) ? messages.length - 1 : 0;
    while (start > 0 && !["assistant", "model"].includes(messages[start - 1]?.role)
      && !["function_call", "reasoning"].includes(messages[start - 1]?.type)) start--;
    const current = conversation(Array.isArray(messages) ? messages.slice(start) : messages);
    res.set("Cache-Control", "no-store").json({
      ...describeLog(data, req.params.id), request: current, response: conversation(data.response),
      screenshots: parts.filter((part) => part.kind === "image"),
      system: request.instructions ?? request.system ?? request.systemInstruction,
      raw: data,
    });
  } catch { res.status(404).json({ error: "Log unavailable" }); }
});
logViewer.get(["/", "/llm-logs"], (_req, res) => res.sendFile(fileURLToPath(new URL("./log-viewer/index.html", import.meta.url))));
