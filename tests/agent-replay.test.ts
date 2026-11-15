import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import type { ActiveChange, PageOutline } from "../shared/adaptation.js";
import type { ContentRequest, ContentResponse, UiEvent } from "../extension/src/messages.js";
import { DEFAULTS, recipeKey, type StoredState } from "../extension/src/storage.js";

const intervals = new Set<number>();
let intervalSeq = 1;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((() => {
  const id = intervalSeq++;
  intervals.add(id);
  return id;
}) as unknown as typeof setInterval);
globalThis.clearInterval = ((id?: number) => {
  if (id !== undefined) intervals.delete(Number(id));
}) as unknown as typeof clearInterval;
after(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  succeed() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

const bridge: {
  data: StoredState;
  sendMessage: (tabId: number, request: ContentRequest) => Promise<ContentResponse>;
} = {
  data: structuredClone(DEFAULTS),
  sendMessage: async () => ({ ok: true, result: null }),
};

globalThis.chrome = {
  tabs: {
    onRemoved: { addListener() {} },
    sendMessage: (tabId: number, request: ContentRequest) => bridge.sendMessage(tabId, request),
  },
  storage: {
    local: {
      get: async () => bridge.data,
      set: async (patch: Partial<StoredState>) => {
        Object.assign(bridge.data, patch);
      },
    },
  },
  runtime: { sendMessage: async () => undefined },
} as unknown as typeof chrome;

const { AgentClient } = await import("../extension/src/background/agent.js");

const ORIGIN = "http://localhost:8787";
const tab = { id: 7, windowId: 1, url: `${ORIGIN}/demo/form.html` } as chrome.tabs.Tab;
const savedChange: ActiveChange = {
  id: "bigger-text",
  summary: "Enlarge page text",
  reason: "Saved from an earlier request.",
  css: "p { font-size: 20px !important; }",
  dom: null,
  block: null,
  scope: "site",
  appliedAt: 1,
};
const outline = {
  url: tab.url,
  title: "Contact form",
  headings: ["Contact form"],
  elements: [],
  itemGroups: [],
  stats: { inputsWithoutLabel: 0, smallTargets: 0, smallText: 0, lowContrastText: 0, imagesWithoutAlt: 0, runningAnimations: 0, visibleAdsOrPopups: 0 },
  styleHints: { background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", fontSizePx: 16, fontFamily: "sans-serif" },
  textSample: "Contact form",
} as PageOutline;

function rememberRecipe() {
  bridge.data = structuredClone(DEFAULTS);
  bridge.data.commands = [{ id: "cmd-1", name: "Bigger", prompt: "make the text bigger", everywhere: true, appliedOrigins: [], createdAt: 1 }];
  bridge.data.recipes = { [recipeKey(ORIGIN, "make the text bigger")]: { message: "make the text bigger", changes: [savedChange], at: 1 } };
}

async function nextSocket(index: number): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const socket = FakeSocket.all[index];
    if (socket?.onopen) return socket;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`socket ${index} was not opened`);
}

function hold<T>() {
  let release: (value: T) => void = () => {};
  const gate = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { gate, release: (value: T) => release(value) };
}

beforeEach(() => {
  FakeSocket.all = [];
  intervals.clear();
  bridge.data = structuredClone(DEFAULTS);
  bridge.sendMessage = async () => ({ ok: true, result: null });
});

describe("recipe replay when the run stops", () => {
  it("does not mark an everywhere command stopped during the page read", async () => {
    rememberRecipe();
    const read = hold<ContentResponse>();
    let reading = false;
    bridge.sendMessage = async (_tabId, request) => {
      if (request.kind === "tool" && request.name === "read_page") {
        reading = true;
        return read.gate;
      }
      return { ok: true, result: [] };
    };
    const events: UiEvent[] = [];
    const agent = new AgentClient({ event: (_tabId, event) => events.push(event), tool: () => undefined, status: () => undefined });
    const pending = agent.startRun(tab, "chat", "make the text bigger", { commandId: "cmd-1" });
    for (let attempt = 0; attempt < 40 && !reading; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reading, true);
    agent.stopRun(tab.id!);
    read.release({ ok: true, result: outline });
    await pending;
    assert.deepEqual(bridge.data.commands[0]?.appliedOrigins, []);
    assert.equal(FakeSocket.all.length, 0);
    assert.equal(events.some((event) => event.type === "done"), false);
  });

  it("does not mark an everywhere command stopped while a saved change is applying", async () => {
    rememberRecipe();
    const apply = hold<ContentResponse>();
    let applying = false;
    bridge.sendMessage = async (_tabId, request) => {
      if (request.kind === "tool" && request.name === "read_page") return { ok: true, result: outline };
      if (request.kind === "tool" && request.name === "apply_change") {
        applying = true;
        return apply.gate;
      }
      return { ok: true, result: [] };
    };
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const pending = agent.startRun(tab, "chat", "make the text bigger", { commandId: "cmd-1" });
    for (let attempt = 0; attempt < 40 && !applying; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(applying, true);
    agent.stopRun(tab.id!);
    apply.release({ ok: true, result: { ok: true, matched: {}, before: outline.stats, after: outline.stats } });
    await pending;
    assert.deepEqual(bridge.data.commands[0]?.appliedOrigins, []);
    assert.equal(FakeSocket.all.length, 0);
  });

  it("does not mark an everywhere command done when the saved change is a no-op", async () => {
    rememberRecipe();
    bridge.sendMessage = async (_tabId, request) => {
      if (request.kind === "tool" && request.name === "read_page") return { ok: true, result: outline };
      if (request.kind === "tool" && request.name === "apply_change") {
        return { ok: true, result: { ok: true, noop: true, matched: {}, before: outline.stats, after: outline.stats } };
      }
      return { ok: true, result: [] };
    };
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const pending = agent.startRun(tab, "chat", "make the text bigger", { commandId: "cmd-1" });
    const socket = await nextSocket(FakeSocket.all.length);
    socket.succeed();
    await pending;
    assert.deepEqual(bridge.data.commands[0]?.appliedOrigins, []);
  });
});

describe("socket lifetime", () => {
  beforeEach(() => {
    bridge.sendMessage = async (_tabId, request) => {
      if (request.kind === "tool" && request.name === "read_page") return { ok: true, result: outline };
      if (request.kind === "list") return { ok: true, result: [] };
      return { ok: true, result: null };
    };
  });

  it("fails runs sent on a socket when that socket closes after a newer one is open", async () => {
    const events: UiEvent[] = [];
    const agent = new AgentClient({ event: (_tabId, event) => events.push(event), tool: () => undefined, status: () => undefined });
    const first = agent.startRun(tab, "chat", "make the text bigger", { fresh: true });
    const socketA = await nextSocket(0);
    socketA.succeed();
    await first;
    socketA.readyState = FakeSocket.CLOSING;
    const reconnect = agent.ensureConnected();
    const socketB = await nextSocket(1);
    socketB.succeed();
    await reconnect;
    socketA.close();
    assert.ok(events.some((event) => event.type === "error" && event.message === "Lost connection to the agent server."));
    assert.equal(agent.status.busy, false);
    assert.equal(agent.status.connected, true);
    await agent.startRun(tab, "chat", "again please", { fresh: true });
    assert.ok(socketB.sent.some((body) => body.includes("again please")));
  });

  it("applies a saved dark mode after the other recipe changes", async () => {
    const dark = { ...savedChange, id: "dark-mode", css: null, block: { name: "darkMode" as const, allowSiteControls: true }, summary: "Dark mode" };
    const dim = { ...savedChange, id: "dim", summary: "Dim the page" };
    bridge.data = structuredClone(DEFAULTS);
    bridge.data.recipes = { [recipeKey(ORIGIN, "dark mode")]: { message: "dark mode", changes: [dark, dim], at: 1 } };
    const order: string[] = [];
    bridge.sendMessage = async (_tabId, request) => {
      if (request.kind === "tool" && request.name === "read_page") return { ok: true, result: outline };
      if (request.kind === "tool" && request.name === "apply_change") {
        order.push((request.input as { change: { id: string } }).change.id);
        return { ok: true, result: { ok: true, matched: {}, before: outline.stats, after: outline.stats } };
      }
      if (request.kind === "list") return { ok: true, result: [] };
      return { ok: true, result: null };
    };
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    await agent.startRun(tab, "chat", "dark mode");
    assert.deepEqual(order, ["dim", "dark-mode"]);
  });

  it("dials the new server address when it changes during a connect and drops the old ping", async () => {
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const opening = agent.ensureConnected();
    const socketA = await nextSocket(0);
    socketA.succeed();
    await opening;
    assert.equal(intervals.size, 1);
    const next = "ws://127.0.0.1:9999/agent";
    bridge.data.serverUrl = next;
    agent.useServer(next);
    assert.equal(intervals.size, 0);
    const socketB = await nextSocket(1);
    assert.equal(socketB.url, next);
    socketA.succeed();
    socketB.succeed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(socketA.readyState, FakeSocket.CLOSED);
    assert.equal(intervals.size, 1);
  });

  it("follows a server change for a caller that is not a chat run", async () => {
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const started = FakeSocket.all.length;
    const pending = agent.ensureConnected();
    const socketA = await nextSocket(started);
    const next = "ws://127.0.0.1:10002/agent";
    bridge.data.serverUrl = next;
    agent.useServer(next);
    const socketB = await nextSocket(started + 1);
    socketA.succeed();
    socketB.succeed();
    await pending;
    assert.equal(socketB.url, next);
    assert.equal(socketB.readyState, FakeSocket.OPEN);
  });

  it("follows a server change instead of failing the request that was already waiting", async () => {
    const events: UiEvent[] = [];
    const agent = new AgentClient({ event: (_tabId, event) => events.push(event), tool: () => undefined, status: () => undefined });
    const started = FakeSocket.all.length;
    const pending = agent.startRun(tab, "chat", "make the text bigger", { fresh: true });
    const socketA = await nextSocket(started);
    const next = "ws://127.0.0.1:10001/agent";
    bridge.data.serverUrl = next;
    agent.useServer(next);
    const socketB = await nextSocket(started + 1);
    socketA.succeed();
    socketB.succeed();
    await pending;
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.ok(socketB.sent.some((body) => body.includes("make the text bigger")));
  });

  it("ignores a socket that opens after the server address changed", async () => {
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const started = FakeSocket.all.length;
    const late = agent.ensureConnected();
    const socketC = await nextSocket(started);
    const next = "ws://127.0.0.1:10000/agent";
    bridge.data.serverUrl = next;
    agent.useServer(next);
    const socketD = await nextSocket(started + 1);
    assert.equal(socketD.url, next);
    socketC.succeed();
    socketD.succeed();
    await late.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(socketC.readyState, FakeSocket.CLOSED);
    assert.equal(socketD.readyState, FakeSocket.OPEN);
  });

  it("stops the previous ping when a replacement socket opens", async () => {
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const opening = agent.ensureConnected();
    const socketA = await nextSocket(0);
    socketA.succeed();
    await opening;
    assert.equal(intervals.size, 1);
    socketA.readyState = FakeSocket.CLOSING;
    const again = agent.ensureConnected();
    const socketB = await nextSocket(1);
    socketB.succeed();
    await again;
    assert.equal(intervals.size, 1);
    socketA.close();
    assert.equal(intervals.size, 1);
  });

  it("rejects a failed handshake at once while an older socket is still assigned", async () => {
    const agent = new AgentClient({ event: () => undefined, tool: () => undefined, status: () => undefined });
    const opening = agent.ensureConnected();
    const socketA = await nextSocket(0);
    socketA.succeed();
    await opening;
    socketA.readyState = FakeSocket.CLOSING;
    const again = agent.ensureConnected().then(() => "open" as const, () => "fail" as const);
    const socketB = await nextSocket(1);
    socketB.onerror?.({});
    const outcome = await Promise.race([
      again,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 150)),
    ]);
    assert.equal(outcome, "fail");
  });
});
