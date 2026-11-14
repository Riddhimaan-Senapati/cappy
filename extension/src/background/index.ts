import type { BackgroundRequest, DebugPortMessage, DebugPortRequest, StatusInfo, UiEvent } from "../messages.js";
import { load } from "../storage.js";
import { AgentClient, sendToTab } from "./agent.js";
import { handleVoiceRequest } from "./voice.js";
import { registerTts } from "./tts.js";

registerTts();

const debugPorts = new Set<chrome.runtime.Port>();

function broadcast(message: DebugPortMessage) {
  for (const port of debugPorts) port.postMessage(message);
}

const agent = new AgentClient({
  event(tabId: number, event: UiEvent) {
    void chrome.tabs.sendMessage(tabId, { kind: "ui", event }).catch(() => undefined);
    broadcast({ type: "event", tabId, at: Date.now(), event });
  },
  tool(tabId, name, ms, ok, detail) {
    broadcast({ type: "tool", tabId, at: Date.now(), name, ms, ok, detail });
  },
  status(status: StatusInfo) {
    broadcast({ type: "status", status });
  },
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function toggleSpotlight(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id) return;
  try {
    await sendToTab(tab.id, { kind: "toggleSpotlight" });
  } catch {
    await chrome.action.openPopup().catch(() => undefined);
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-spotlight") await toggleSpotlight(tab ?? (await activeTab()));
  if (command === "open-debug") {
    const target = tab ?? (await activeTab());
    if (target?.windowId) await chrome.sidePanel.open({ windowId: target.windowId }).catch(() => undefined);
  }
});

async function maybeRunProactively(tab: chrome.tabs.Tab, origin: string, restored: number) {
  const state = await load();
  if (!state.proactive || state.paused || !state.profile.length || restored > 0 || !tab.id) return;
  const key = `${tab.id}|${origin}`;
  const { proactiveSeen = [] } = (await chrome.storage.session.get("proactiveSeen")) as { proactiveSeen?: string[] };
  if (proactiveSeen.includes(key)) return;
  await chrome.storage.session.set({ proactiveSeen: [...proactiveSeen.slice(-100), key] });
  await agent.startRun(tab, "page_load", "");
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  if (handleVoiceRequest(request, sender)) return false;
  switch (request.kind) {
    case "runChat":
      if (sender.tab) void agent.startRun(sender.tab, "chat", request.message, request.fresh);
      break;
    case "pageReady":
      if (sender.tab) void maybeRunProactively(sender.tab, request.origin, request.restored);
      break;
    case "openDebug":
      if (sender.tab?.id) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => undefined);
      break;
    case "openShortcuts":
      void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      break;
    case "status":
      void agent.ensureConnected().catch(() => undefined).finally(() => sendResponse(agent.status));
      return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "debug") return;
  debugPorts.add(port);
  port.postMessage({ type: "status", status: agent.status } satisfies DebugPortMessage);
  void agent.ensureConnected().catch(() => undefined);
  port.onMessage.addListener(async (request: DebugPortRequest) => {
    const tab = await activeTab();
    if (request.type === "chat" && tab) await agent.startRun(tab, "chat", request.message, true);
  });
  port.onDisconnect.addListener(() => debugPorts.delete(port));
});

void agent.ensureConnected().catch(() => undefined);
