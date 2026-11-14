import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDemo, runE2E, shadowTextVisible, waitFor } from "./lib.js";

// 16 kHz mono WAV: silence, a speech-like burst, then silence long enough for the pause countdown to finish.
function speechWav(): string {
  const rate = 16_000;
  const segments: Array<[seconds: number, loud: boolean]> = [[0.6, false], [1.4, true], [8, false]];
  const samples = segments.reduce((total, [seconds]) => total + Math.round(seconds * rate), 0);
  const data = Buffer.alloc(samples * 2);
  let offset = 0;
  let n = 0;
  for (const [seconds, loud] of segments) {
    for (let i = 0; i < Math.round(seconds * rate); i++, n++) {
      const value = loud ? 0.25 * Math.sin((2 * Math.PI * 220 * n) / rate) + 0.15 * Math.sin((2 * Math.PI * 470 * n) / rate) : 0.0008 * (Math.random() - 0.5);
      data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), offset);
      offset += 2;
    }
  }
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
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "ba-voice-")), "speech.wav");
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

await runE2E("voice-point", async ({ browser }) => {
  const demo = await openDemo(browser, "/demo/campus.html");
  const [worker] = browser.context.serviceWorkers();
  await worker.evaluate(() => chrome.storage.local.set({ voiceProvider: "openai", openAIVoiceVerified: true, voiceAutoSend: true }));
  const heading = demo.locator("h1").first();
  const box = await heading.boundingBox();
  assert.ok(box, "the demo page has a heading to point at");
  await demo.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id);
  await worker.evaluate((id) => chrome.tabs.sendMessage(id!, { kind: "startVoice" }), tabId);
  await waitFor("the listening pill", () => shadowTextVisible(demo, "Listening"));
  await waitFor("the about-to-send countdown after the speech ends", () => shadowTextVisible(demo, "Sending"));
  await waitFor("the pointed heading to be removed", () => heading.isHidden());
  assert.ok(await demo.locator("main, body").first().isVisible(), "only the pointed element was removed");

  // With the bar open and nothing typed, the shortcut steps the bar aside so the page can be pointed at.
  const second = demo.locator("h2").first();
  const secondBox = await second.boundingBox();
  assert.ok(secondBox, "the demo page has a second heading");
  await worker.evaluate((id) => chrome.tabs.sendMessage(id!, { kind: "toggleSpotlight" }), tabId);
  await demo.waitForTimeout(800);
  await demo.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await worker.evaluate((id) => chrome.tabs.sendMessage(id!, { kind: "startVoice" }), tabId);
  await waitFor("the listening pill with the bar out of the way", () => shadowTextVisible(demo, "Listening"));
  await waitFor("the second pointed heading to be removed", () => second.isHidden());
}, { fakeAudio: speechWav() });
