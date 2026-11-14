import type { BackgroundRequest, DebugPortMessage, DebugPortRequest, StatusInfo, UiEvent } from "../messages.js";
import { load } from "../storage.js";
import { AgentClient, sendToTab } from "./agent.js";

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

const CONTENT_SCRIPT = "dist/content.js";

async function injectContent(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
}

async function toggleSpotlight(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id) return;
  try {
    await sendToTab(tab.id, { kind: "toggleSpotlight" });
    return;
  } catch {
    // tabs opened before the extension was (re)loaded have no content script yet
  }
  try {
    await injectContent(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToTab(tab.id, { kind: "toggleSpotlight" });
  } catch {
    await chrome.action.openPopup().catch(() => undefined);
  }
}

// An earlier version made the toolbar icon open the side panel, and Chrome persists that choice.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "adapt-element" && tab?.id) void sendToTab(tab.id, { kind: "targetContextElement" }).catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: "adapt-element", title: "Adapt this with Adaptive Agent", contexts: ["all"] }, () => void chrome.runtime.lastError);
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (tab.id) void injectContent(tab.id).catch(() => undefined);
  }
});

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
  switch (request.kind) {
    case "runChat":
      if (sender.tab) void agent.startRun(sender.tab, "chat", request.message, request.fresh, undefined, undefined, request.target);
      break;
    case "pageReady":
      if (sender.tab) {
        void agent.runEverywhereCommands(sender.tab, request.origin);
        void maybeRunProactively(sender.tab, request.origin, request.restored);
      }
      break;
    case "openDebug":
      if (sender.tab?.id) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => undefined);
      break;
    case "openShortcuts":
      void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      break;
    case "status":
      void agent.ensureConnected().catch(() => undefined).then(() => agent.getStatus()).then(sendResponse);
      return true;
    case "setKey":
      void agent.setKey(request.provider, request.key).catch(() => undefined);
      break;
    case "chatgptLogin":
      void agent.signIn().catch(() => undefined);
      break;
    case "suggest":
      void agent.suggest(request.page, request.applied).then(sendResponse);
      return true;
    case "stopRun":
      if (sender.tab?.id) agent.stopRun(sender.tab.id);
      break;
    case "dequeue":
      if (sender.tab?.id) agent.dequeue(sender.tab.id, request.runId);
      break;
    case "chatgptLogout":
      void agent.signOut().catch(() => undefined);
      break;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "debug") return;
  debugPorts.add(port);
  void agent.getStatus().then((status) => port.postMessage({ type: "status", status } satisfies DebugPortMessage));
  void agent.ensureConnected().catch(() => undefined);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.provider) void agent.ensureModels();
});
  port.onMessage.addListener(async (request: DebugPortRequest) => {
    const tab = await activeTab();
    if (request.type === "chat" && tab) await agent.startRun(tab, "chat", request.message, true);
  });
  port.onDisconnect.addListener(() => debugPorts.delete(port));
});

void agent.ensureConnected().catch(() => undefined);
