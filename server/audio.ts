import express from "express";
import OpenAI from "openai";
import { getKey } from "./keys.js";

export const audio = express.Router();

audio.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    res.sendStatus(403);
    return;
  }
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST");
  if (req.method === "OPTIONS") res.sendStatus(204);
  else next();
});

audio.post("/speech", express.json({ limit: "24kb" }), async (req, res) => {
  const apiKey = getKey("OPENAI_API_KEY");
  if (!apiKey) { res.sendStatus(503); return; }
  const { text, rate } = req.body ?? {};
  if (typeof text !== "string" || !text.trim() || text.length > 4096) { res.sendStatus(400); return; }
  try {
    const speech = await new OpenAI({ apiKey }).audio.speech.create({
      input: text, voice: "coral", model: "gpt-4o-mini-tts",
      speed: typeof rate === "number" ? Math.max(0.5, Math.min(2, rate)) : 1,
    });
    res.type("audio/mpeg").send(Buffer.from(await speech.arrayBuffer()));
  } catch {
    res.sendStatus(502);
  }
});

audio.post("/transcribe", express.raw({ type: "audio/webm", limit: "5mb" }), async (req, res) => {
  const apiKey = getKey("OPENAI_API_KEY");
  if (!apiKey) { res.sendStatus(503); return; }
  if (!Buffer.isBuffer(req.body) || !req.body.length) { res.sendStatus(400); return; }
  try {
    const file = new File([new Uint8Array(req.body)], "recording.webm", { type: "audio/webm" });
    const result = await new OpenAI({ apiKey }).audio.transcriptions.create({ file, model: "gpt-4o-mini-transcribe" });
    res.json({ text: result.text });
  } catch {
    res.sendStatus(502);
  }
});

audio.post("/verify", async (_req, res) => {
  const apiKey = getKey("OPENAI_API_KEY");
  if (!apiKey) {
    res.status(503).json({ error: "Add an OpenAI API key in Model provider first." });
    return;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: 12_000, maxRetries: 0 });
    const speech = await client.audio.speech.create({
      input: "Voice check.", voice: "coral", model: "gpt-4o-mini-tts", response_format: "wav",
    });
    const file = new File([await speech.arrayBuffer()], "voice-check.wav", { type: "audio/wav" });
    await client.audio.transcriptions.create({ file, model: "gpt-4o-mini-transcribe" });
    if (apiKey !== getKey("OPENAI_API_KEY")) {
      res.status(409).json({ error: "The API key changed. Verify it again." });
      return;
    }
    res.sendStatus(204);
  } catch {
    res.status(502).json({ error: "OpenAI audio verification failed. Check the key, billing, and access to both audio models." });
  }
});
