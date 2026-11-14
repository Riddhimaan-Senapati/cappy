import express from "express";
import OpenAI from "openai";
import { getKey, setKey } from "./keys.js";

export const audio = express.Router();

const audioKey = () => getKey("OPENAI_AUDIO_API_KEY") ?? getKey("OPENAI_API_KEY");

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
  const apiKey = audioKey();
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
  const apiKey = audioKey();
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

audio.post("/verify", express.json({ limit: "8kb" }), async (req, res) => {
  const previous = audioKey();
  const candidate = req.body?.key;
  if (candidate !== undefined && (typeof candidate !== "string" || !candidate || candidate.length > 4096 || /\s/.test(candidate))) {
    res.status(400).json({ error: "Enter a valid OpenAI API key." });
    return;
  }
  const apiKey = candidate ?? previous;
  if (!apiKey) {
    res.status(503).json({ error: "Enter an OpenAI API key in the extension popup under Model → Voice provider." });
    return;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: 12_000, maxRetries: 0 });
    const speech = await client.audio.speech.create({
      input: "Voice check.", voice: "coral", model: "gpt-4o-mini-tts", response_format: "wav",
    });
    const file = new File([await speech.arrayBuffer()], "voice-check.wav", { type: "audio/wav" });
    await client.audio.transcriptions.create({ file, model: "gpt-4o-mini-transcribe" });
    if (previous !== audioKey()) {
      res.status(409).json({ error: "The API key changed. Verify it again." });
      return;
    }
    if (candidate) setKey("OPENAI_AUDIO_API_KEY", candidate);
    res.sendStatus(204);
  } catch {
    res.status(502).json({ error: "OpenAI audio verification failed. Check the key, billing, and access to both audio models." });
  }
});
