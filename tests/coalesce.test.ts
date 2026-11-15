import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCoalescer, settle } from "../extension/src/coalesce.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("coalescing runner", () => {
  it("runs one task and returns to idle", async () => {
    const runner = createCoalescer(500);
    let ran = 0;
    runner.start(async () => {
      ran += 1;
    });
    assert.equal(runner.phase(), "running");
    await wait(20);
    assert.equal(ran, 1);
    assert.equal(runner.phase(), "idle");
  });

  it("folds a start during a run into one follow-up", async () => {
    const runner = createCoalescer(500);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    runner.start(async () => {
      seen.push("first");
      await gate;
    });
    runner.start(async () => {
      seen.push("second");
    });
    runner.start(async () => {
      seen.push("third");
    });
    assert.equal(runner.phase(), "running-dirty");
    release();
    await wait(30);
    assert.deepEqual(seen, ["first", "third"]);
    assert.equal(runner.phase(), "idle");
  });

  it("drops a stale render when a newer run is waiting", async () => {
    const runner = createCoalescer(500);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rendered = 0;
    runner.start(async (current) => {
      await gate;
      if (!current()) return;
      rendered += 1;
    });
    runner.start(async () => undefined);
    release();
    await wait(30);
    assert.equal(rendered, 0);
    assert.equal(runner.phase(), "idle");
  });

  it("returns to idle when a task never settles, so a later run still happens", async () => {
    const runner = createCoalescer(30);
    runner.start(() => new Promise(() => undefined));
    assert.equal(runner.phase(), "running");
    await wait(60);
    assert.equal(runner.phase(), "idle");
    let ran = 0;
    runner.start(async () => {
      ran += 1;
    });
    await wait(20);
    assert.equal(ran, 1);
    assert.equal(runner.phase(), "idle");
  });

  it("returns to idle when a task rejects", async () => {
    const runner = createCoalescer(500);
    runner.start(async () => {
      throw new Error("paint failed");
    });
    await wait(20);
    assert.equal(runner.phase(), "idle");
    let ran = 0;
    runner.start(async () => {
      ran += 1;
    });
    await wait(20);
    assert.equal(ran, 1);
  });

  it("marks a timed-out run stale so it cannot paint later", async () => {
    const runner = createCoalescer(20);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let currentAfter = true;
    runner.start(async (current) => {
      await gate;
      currentAfter = current();
    });
    await wait(50);
    assert.equal(runner.phase(), "idle");
    release();
    await wait(20);
    assert.equal(currentAfter, false);
  });
});

describe("settle", () => {
  it("resolves a rejection with the fallback", async () => {
    const value = await settle(Promise.reject(new Error("down")), { connected: false, busy: false }, 200);
    assert.deepEqual(value, { connected: false, busy: false });
  });

  it("resolves a hang with the fallback", async () => {
    const value = await settle(new Promise<{ ok: boolean }>(() => undefined), { ok: false }, 20);
    assert.deepEqual(value, { ok: false });
  });

  it("returns the value when the work finishes", async () => {
    const value = await settle(Promise.resolve(7), 0, 200);
    assert.equal(value, 7);
  });
});
