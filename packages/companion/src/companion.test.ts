import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { emptyCheckpoint, type CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import type { LlmRequest } from "@browser-agent/shared";
import { createCompanion, type Llm } from "./index";
import { IndexedDBSaver } from "./indexeddb-saver";

const fakeLlm: Llm = async (req: LlmRequest) => {
  const last = req.messages.at(-1)?.content ?? "";
  if (/colorblind/i.test(last)) {
    return {
      text: JSON.stringify({
        reply: "Thanks, I'll note that.",
        proposal: { kind: "color_vision", detail: "Red-green colorblind", why: "Stated directly" },
      }),
    };
  }
  return { text: JSON.stringify({ reply: "Hi! Are bright screens ever uncomfortable?", proposal: null }) };
};

const freshDb = () => `test-${crypto.randomUUID()}`;

describe("companion", () => {
  test("plain message gets a reply and no proposal", async () => {
    const companion = await createCompanion({ llm: fakeLlm, threadId: "t1", dbName: freshDb() });
    const view = await companion.send("hi");
    expect(view.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hi! Are bright screens ever uncomfortable?" },
    ]);
    expect(view.pending).toBeNull();
    expect(view.profile.needs).toEqual([]);
  });

  test("a stated need becomes a pending proposal and blocks further sends", async () => {
    const companion = await createCompanion({ llm: fakeLlm, threadId: "t1", dbName: freshDb() });
    const view = await companion.send("I'm red-green colorblind");
    expect(view.pending?.kind).toBe("add_need");
    expect(view.pending?.need.kind).toBe("color_vision");
    expect(view.pending?.need.source).toBe("onboarding");
    await expect(companion.send("hello?")).rejects.toThrow("decide the pending proposal first");
  });

  test("pending proposal and history survive a restart, then accepting saves the need", async () => {
    const dbName = freshDb();
    const before = await createCompanion({ llm: fakeLlm, threadId: "t1", dbName });
    await before.send("I'm red-green colorblind");

    const restarted = await createCompanion({ llm: fakeLlm, threadId: "t1", dbName });
    const resumed = await restarted.view();
    expect(resumed.pending?.need.kind).toBe("color_vision");
    expect(resumed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const decided = await restarted.decide(true);
    expect(decided.pending).toBeNull();
    expect(decided.profile.version).toBe(1);
    expect(decided.profile.needs).toHaveLength(1);
    expect(decided.profile.needs[0]?.kind).toBe("color_vision");
    expect(decided.messages.at(-1)).toEqual({ role: "assistant", content: "Saved: Red-green colorblind" });
  });

  test("rejecting a proposal saves nothing", async () => {
    const companion = await createCompanion({ llm: fakeLlm, threadId: "t2", dbName: freshDb() });
    await companion.send("I'm red-green colorblind");
    const view = await companion.decide(false);
    expect(view.pending).toBeNull();
    expect(view.profile.needs).toEqual([]);
    expect(view.profile.version).toBe(0);
    expect(view.messages.at(-1)).toEqual({ role: "assistant", content: "Okay, I won't save that." });
  });

  test("decide with nothing pending is an error", async () => {
    const companion = await createCompanion({ llm: fakeLlm, threadId: "t3", dbName: freshDb() });
    await expect(companion.decide(true)).rejects.toThrow("no pending proposal");
  });
});

describe("IndexedDBSaver", () => {
  const metadata: CheckpointMetadata = { source: "update", step: 0, parents: {} };
  const configFor = (thread: string, checkpointId?: string) => ({
    configurable: { thread_id: thread, checkpoint_ns: "", ...(checkpointId ? { checkpoint_id: checkpointId } : {}) },
  });

  test("put then getTuple round-trips checkpoint, metadata and pending writes", async () => {
    const saver = new IndexedDBSaver({ dbName: freshDb() });
    const checkpoint = { ...emptyCheckpoint(), id: "c1" };
    await saver.put(configFor("t"), checkpoint, metadata);
    await saver.putWrites(configFor("t", "c1"), [["color", { hue: "red" }]], "task-a", "");

    const tuple = await saver.getTuple(configFor("t"));
    expect(tuple?.checkpoint.id).toBe("c1");
    expect(tuple?.metadata).toEqual(metadata);
    expect(tuple?.pendingWrites).toEqual([["task-a", "color", { hue: "red" }]]);
    expect(tuple?.config.configurable?.checkpoint_id).toBe("c1");

    const exact = await saver.getTuple(configFor("t", "c1"));
    expect(exact?.checkpoint.id).toBe("c1");
    expect(await saver.getTuple(configFor("missing"))).toBeUndefined();
  });

  test("list returns checkpoints newest first and honours limit", async () => {
    const saver = new IndexedDBSaver({ dbName: freshDb() });
    await saver.put(configFor("t"), { ...emptyCheckpoint(), id: "c1" }, metadata);
    await saver.put({ configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "c1" } }, { ...emptyCheckpoint(), id: "c2" }, metadata);
    await saver.put({ configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "c2" } }, { ...emptyCheckpoint(), id: "c3" }, metadata);

    const ids: string[] = [];
    for await (const tuple of saver.list(configFor("t"))) ids.push(tuple.checkpoint.id);
    expect(ids).toEqual(["c3", "c2", "c1"]);

    const limited: string[] = [];
    for await (const tuple of saver.list(configFor("t"), { limit: 2 })) limited.push(tuple.checkpoint.id);
    expect(limited).toEqual(["c3", "c2"]);
  });

  test("deleteThread removes checkpoints and writes for that thread only", async () => {
    const saver = new IndexedDBSaver({ dbName: freshDb() });
    await saver.put(configFor("keep"), { ...emptyCheckpoint(), id: "k1" }, metadata);
    await saver.put(configFor("drop"), { ...emptyCheckpoint(), id: "d1" }, metadata);
    await saver.putWrites(configFor("drop", "d1"), [["color", "x"]], "task", "");
    await saver.deleteThread("drop");
    expect(await saver.getTuple(configFor("drop"))).toBeUndefined();
    expect((await saver.getTuple(configFor("keep")))?.checkpoint.id).toBe("k1");
  });
});
