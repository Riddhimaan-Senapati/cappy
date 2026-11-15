import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { llmFetch } from "../server/llm-logs.js";

const directory = new URL("../llm_logs/", import.meta.url);

test("LLM logging is opt-in, summarizes requests, and preserves streamed responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetting = process.env.log_llm_requests;
  const before = new Set(await readdir(directory).catch(() => []));
  const image = Buffer.from("cappy-test-image");
  const imageName = createHash("sha256").update(image).digest("hex") + ".png";
  const imagePath = new URL("images/" + imageName, directory);
  const imageExisted = await readFile(imagePath).then(() => true, () => false);
  const request = {
    instructions: "System instructions. ".repeat(100),
    contents: [{ inlineData: { mimeType: "image/png", data: image.toString("base64") } }],
    input: [{ role: "user", content: `Adapt this page:\n<html>${"x".repeat(100_000)}</html>\nMake it readable.` }],
  };
  const reply = { output: [{ text: "A readable reply. ".repeat(30) + "\nSecond line." }] };
  let sent = "";
  const created: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    sent = init?.body as string;
    return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "A" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    process.env.log_llm_requests = "false";
    await (await llmFetch("https://example.test", { body: JSON.stringify(request) })).text();
    assert.deepEqual(await readdir(directory).catch(() => []), [...before]);
    process.env.log_llm_requests = "true";
    const response = await llmFetch("https://example.test", { body: JSON.stringify(request) });
    assert.match(await response.text(), /response.completed/);
    assert.deepEqual(JSON.parse(sent), request);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".yaml") && !before.has(name));
    created.push(...files);
    assert.equal(files.length, 1);
    const yaml = await readFile(new URL(files[0], directory), "utf8");
    const logged = parse(yaml);
    assert.deepEqual(Object.keys(logged), ["request", "response"]);
    assert.equal(logged.request.instructions, request.instructions);
    assert.equal(logged.request.input[0].content, "Adapt this page:\n<html>{{html__size_100_000}}</html>\nMake it readable.");
    assert.deepEqual(logged.response, reply);
    assert.equal(logged.request.contents[0].inlineData.data, "/api/llm-logs/images/" + imageName);
    assert.deepEqual(await readFile(imagePath), image);
    assert.ok(yaml.split("\n").every((line) => line.length <= 100 || line.includes("/api/llm-logs/images/")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSetting === undefined) delete process.env.log_llm_requests;
    else process.env.log_llm_requests = originalSetting;
    if (!imageExisted) await unlink(imagePath).catch(() => {});
    for (const name of created) await unlink(new URL(name, directory));
  }
});
