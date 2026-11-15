import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { bridgeLive, LIVE_RATE, parseFromClient, SharedReplies, TaskText, TASK_QUIET_MS, TASK_SHARE_MS } from "../server/live.js";
import { floatToPcm16, liveUrl, parseLiveMessage, pcm16ToFloat } from "../extension/src/voice/pcm.js";

describe("GPT-Live task text", () => {
  it("waits for transcription to go quiet, then takes only what was said since the last task", () => {
    const text = new TaskText();
    text.add("Make the ", 1_000);
    text.add("text bigger", 1_200);
    assert.equal(text.settled(1_200 + TASK_QUIET_MS - 1), false);
    assert.equal(text.settled(1_200 + TASK_QUIET_MS), true);
    assert.equal(text.pending(), "Make the text bigger");
    assert.equal(text.take(), "Make the text bigger");
    assert.equal(text.pending(), "");
    text.add("  and hide   the ads ", 3_000);
    assert.equal(text.take(), "and hide the ads");
    assert.equal(text.take(), "");
  });

  it("accepts only well-formed results from the extension", () => {
    assert.deepEqual(parseFromClient(JSON.stringify({ type: "result", id: "item_1", text: "Done." })), { type: "result", id: "item_1", text: "Done." });
    assert.equal(parseFromClient("not json"), null);
    assert.equal(parseFromClient(JSON.stringify({ type: "result", id: 5, text: "x" })), null);
    assert.equal(parseFromClient(JSON.stringify({ type: "other", id: "a", text: "x" })), null);
    assert.equal(parseFromClient(JSON.stringify({ type: "result", id: "a", text: "x".repeat(5_000) }))?.text.length, 2_000);
  });
});

describe("GPT-Live shared replies", () => {
  it("lets a delegation with no new words share the task that just started", () => {
    const replies = new SharedReplies();
    replies.open("first", 1_000);
    assert.equal(replies.join("second", 1_000 + TASK_SHARE_MS - 1), true);
    assert.deepEqual(replies.close("first"), ["first", "second"]);
    assert.deepEqual(replies.close("first"), ["first"], "a result is shared once");
  });

  it("does not attach a late or orphan delegation", () => {
    const replies = new SharedReplies();
    assert.equal(replies.join("alone", 0), false);
    replies.open("first", 1_000);
    assert.equal(replies.join("late", 1_000 + TASK_SHARE_MS), false);
    replies.close("first");
    assert.equal(replies.join("after", 1_100), false, "nothing to join once the task answered");
  });
});

describe("GPT-Live socket messages", () => {
  it("keeps well-formed server messages and drops the rest", () => {
    assert.deepEqual(parseLiveMessage(JSON.stringify({ type: "task", id: "a", text: "hide ads" })), { type: "task", id: "a", text: "hide ads" });
    assert.deepEqual(parseLiveMessage(JSON.stringify({ type: "heard", text: "" })), { type: "heard", text: "" });
    assert.deepEqual(parseLiveMessage(JSON.stringify({ type: "ready" })), { type: "ready" });
    assert.equal(parseLiveMessage(JSON.stringify({ type: "task", id: 1, text: "x" })), null);
    assert.equal(parseLiveMessage(JSON.stringify({ type: "unknown" })), null);
    assert.equal(parseLiveMessage("not json"), null);
  });
});

describe("GPT-Live audio helpers", () => {
  it("round-trips PCM16 and clamps out-of-range samples", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
    const back = pcm16ToFloat(floatToPcm16(samples));
    assert.equal(back.length, 5);
    assert.ok(Math.abs(back[1]! - 0.5) < 0.001);
    assert.ok(Math.abs(back[2]! + 0.5) < 0.001);
    assert.ok(back[3]! <= 1 && back[4]! >= -1);
  });

  it("puts the live socket next to the agent socket on the same server", () => {
    assert.equal(liveUrl("ws://localhost:8787/agent"), "ws://localhost:8787/live");
    assert.equal(liveUrl("wss://cappy.example/agent?x=1"), "wss://cappy.example/live");
  });
});

describe("GPT-Live bridge (stub)", () => {
  it("hands a heard request to the extension and takes the agent's reply back", async () => {
    const previous = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "stub";
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => bridgeLive(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const received: Array<Record<string, unknown> | "audio"> = [];
    const seen = (type: string) => received.find((message) => message !== "audio" && message.type === type) as Record<string, unknown> | undefined;
    client.on("message", (data, isBinary) => received.push(isBinary ? "audio" : JSON.parse(String(data))));
    try {
      await new Promise((resolve) => client.once("open", resolve));
      const until = async (check: () => unknown) => {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(check());
      };
      await until(() => seen("ready"));
      client.send(Buffer.alloc(LIVE_RATE * 2));
      await until(() => seen("task"));
      const task = seen("task")!;
      assert.equal(typeof task.text, "string");
      client.send(JSON.stringify({ type: "result", id: task.id, text: "Made the text larger." }));
      await until(() => seen("said") && received.includes("audio"));
      assert.equal(seen("said")!.delta, "Made the text larger.");
    } finally {
      client.close();
      wss.close();
      server.close();
      process.env.LLM_PROVIDER = previous;
    }
  });
});
