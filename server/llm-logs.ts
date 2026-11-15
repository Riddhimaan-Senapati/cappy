import { mkdir, writeFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const directory = fileURLToPath(new URL("../llm_logs/", import.meta.url));
const run = new AsyncLocalStorage<string>();
export const withLogRun = <T>(id: string, task: () => T): T => run.run(id, task);

async function preserveImages(value: any): Promise<any> {
  if (Array.isArray(value)) return Promise.all(value.map(preserveImages));
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    const mime = value.mimeType ?? value.media_type;
    const dataUrl = typeof item === "string" ? item.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/) : null;
    const encoded = dataUrl?.[2] ?? (key === "data" && /^image\/(png|jpeg|webp)$/.test(mime) ? item : null);
    if (typeof encoded === "string" && !encoded.startsWith("{{")) {
      const bytes = Buffer.from(encoded, "base64");
      const extension = (dataUrl?.[1] ?? mime).split("/")[1].replace("jpeg", "jpg");
      const name = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
      await mkdir(`${directory}images`, { recursive: true });
      await writeFile(`${directory}images/${name}`, bytes);
      copy[key] = `/api/llm-logs/images/${name}`;
    } else copy[key] = await preserveImages(item);
  }
  return copy;
}

const placeholder = (name: string, value: string) =>
  `{{${name}__size_${value.length.toLocaleString("en-US").replaceAll(",", "_")}}}`;

// Only the logged copy is shortened; the model receives the original content.
export function summarizeRequest(value: unknown, name = "input"): unknown {
  if (["system", "instructions", "description", "systemInstruction"].includes(name)) return value;
  if (Array.isArray(value)) return value.map((item) => summarizeRequest(item, name));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarizeRequest(item, key)]));
  }
  if (typeof value !== "string") return value;
  // Some tools return JSON serialized inside a text field.
  if (/^\s*[\[{]/.test(value)) {
    try { return summarizeRequest(JSON.parse(value), name); } catch { /* Plain text. */ }
  }
  const shortened = value.replace(/<([\w_]+)>([\s\S]*?)<\/\1>/g, (block, tag: string, content: string) =>
    content.length >= 1000 ? `<${tag}>${placeholder(tag, content)}</${tag}>` : block);
  if (shortened !== value) return shortened;
  return value.length >= 1000 ? placeholder(name, value) : value;
}

function parseBody(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}

function parseEvents(body: string): unknown {
  const events = body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? [parseBody(data)] : [];
  });
  // OpenAI streams include the complete response, so omit all incremental deltas.
  const completed = events.findLast((event: any) => event?.type === "response.completed") as any;
  return completed?.response ?? events;
}

async function save(file: string, request: unknown, response: unknown) {
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}${file}`, stringify({ request: summarizeRequest(await preserveImages(request)), response }, {
      lineWidth: 100,
      minContentWidth: 0,
      defaultStringType: "PLAIN",
      blockQuote: "folded",
      defaultKeyType: "PLAIN",
    }));
  } catch (error) {
    console.warn("[llm-logs] Could not save exchange:", error instanceof Error ? error.message : error);
  }
}

// Inject into each provider's SDK to include every tool-loop request and retry.
export const llmFetch: typeof globalThis.fetch = async (input, init) => {
  const enabled = process.env.log_llm_requests ?? process.env.log_llm_request ?? process.env.LOG_LLM_REQUESTS;
  if (enabled !== "true") return globalThis.fetch(input, init);
  const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
  // Model-list and authentication requests are not LLM exchanges.
  if (!body) return globalThis.fetch(input, init);
  const request = parseBody(body);
  const runId = run.getStore();
  const suffix = runId ? `--run-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}` : "";
  const file = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}${suffix}.yaml`;
  let response: Response;
  try {
    response = await globalThis.fetch(input, init);
  } catch (error) {
    await save(file, request, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    await save(file, request, parseBody(await response.clone().text()));
    return response;
  }
  let text = "";
  const decoder = new TextDecoder();
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      text += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    async flush() {
      text += decoder.decode();
      await save(file, request, parseEvents(text));
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
};
