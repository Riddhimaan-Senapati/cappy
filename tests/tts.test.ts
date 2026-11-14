import assert from "node:assert/strict";
import { test } from "node:test";
import { capForSpeech, chunkForSpeech, cleanForSpeech, MAX_CHUNK_CHARS } from "../shared/speech.js";

test("chunks keep sentences whole and pack them up to the limit", () => {
  assert.deepEqual(chunkForSpeech("One. Two. Three."), ["One. Two. Three."]);
  assert.deepEqual(chunkForSpeech("One. Two. Three.", 10), ["One. Two.", "Three."]);
  assert.deepEqual(chunkForSpeech("Is it? Yes! Done."), ["Is it? Yes! Done."]);
});

test("long sentences are split at clauses and never exceed the limit", () => {
  const clause = "this is a fairly long clause that keeps going";
  const sentence = Array.from({ length: 20 }, () => clause).join(", ") + ".";
  const chunks = chunkForSpeech(sentence);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= MAX_CHUNK_CHARS, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), sentence.replace(/\s+/g, " "));
});

test("words longer than the limit are hard split", () => {
  const word = "x".repeat(450);
  const chunks = chunkForSpeech(word);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [200, 200, 50]);
});

test("empty and whitespace-only input yields no chunks", () => {
  assert.deepEqual(chunkForSpeech(""), []);
  assert.deepEqual(chunkForSpeech("   \n\t  "), []);
  for (const chunk of chunkForSpeech("Hello.\n\n\n   World.")) assert.ok(chunk.trim().length > 0);
});

test("newlines separate sentences and collapse whitespace", () => {
  assert.deepEqual(chunkForSpeech("First line.\n\nSecond   line."), ["First line. Second line."]);
});

test("markdown links, images, bold, headings and code are reduced to speakable text", () => {
  const input = "# Title\n\nSee [the docs](https://example.com/docs) and **bold** and _soft_ text.\n\n- item one\n- item two\n\n`npm run dev` is ~~old~~ ![logo](https://x.test/a.png)";
  assert.equal(cleanForSpeech(input), "Title See the docs and bold and soft text. item one item two npm run dev is old logo");
});

test("bare URLs are removed and code fences are dropped", () => {
  assert.equal(cleanForSpeech("Visit https://example.com/a?b=1 or www.example.org today."), "Visit or today.");
  assert.equal(cleanForSpeech("Before ```ts\nconst x = 1;\n``` after"), "Before after");
});

test("snake_case identifiers keep their underscores", () => {
  assert.equal(cleanForSpeech("Set ttsRate and ttsVoice in storage_local."), "Set ttsRate and ttsVoice in storage_local.");
});

test("page text is capped near the limit at a word boundary", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
  const capped = capForSpeech(text, 200);
  assert.ok(capped.length <= 200);
  assert.ok(capped.length > 160);
  assert.ok(text.startsWith(capped));
  assert.ok(!capped.endsWith("wor") && /word\d+$/.test(capped));
});
