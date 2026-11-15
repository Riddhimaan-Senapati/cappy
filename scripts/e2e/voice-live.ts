import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fontSizeOf, openDemo, runE2E, shadowTextVisible, waitFor } from "./lib.js";

// 16 kHz mono WAV of a steady tone, long enough for the stub to hear a request.
function toneWav(seconds = 20): string {
  const rate = 16_000;
  const data = Buffer.alloc(rate * seconds * 2);
  for (let n = 0; n < rate * seconds; n++) data.writeInt16LE(Math.round(0.2 * Math.sin((2 * Math.PI * 220 * n) / rate) * 32767), n * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "ba-live-")), "tone.wav");
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

// A GPT-Live conversation: microphone audio streams to the server, the heard request runs as a normal agent request on the page,
// and the agent's reply goes back to the voice model to say. The stub server stands in for GPT-Live.
await runE2E("voice-live", async ({ server, browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const [worker] = browser.context.serviceWorkers();
  await worker.evaluate(() => chrome.storage.local.set({ voiceProvider: "live", openAIVoiceVerified: true, speakReplies: true }));
  const before = await fontSizeOf(demo);

  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id);
  await worker.evaluate((id) => chrome.tabs.sendMessage(id!, { kind: "startVoice" }), tabId);
  await waitFor("the listening pill", () => shadowTextVisible(demo, "Listening"));
  await waitFor("the spoken request to enlarge the text", async () => ((await fontSizeOf(demo)) >= before * 1.25 ? true : undefined), 20_000);
  await waitFor("the agent's reply handed back for GPT-Live to say", async () => /\[live\] result: .+/.test(server.output()), 15_000);
  assert.ok(!/\[live\] result: (Open a web page|That did not work)/.test(server.output()), "the reply was the agent's, not a fallback");

  await worker.evaluate((id) => chrome.tabs.sendMessage(id!, { kind: "startVoice" }), tabId);
  await waitFor("the conversation to end when voice is toggled off", async () => !(await shadowTextVisible(demo, "Listening")), 10_000);
}, { fakeAudio: toneWav() });
