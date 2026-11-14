import { requestAudio } from "../voice/audio-api.js";
import type { BackgroundRequest, DebugPortMessage, DebugPortRequest, StatusInfo, UiEvent } from "../messages.js";
import { load, recordSubmittedRequest, removeSubmittedRequest } from "../storage.js";
import { AgentClient, sendToTab } from "./agent.js";
import { handleVoiceRequest } from "./voice.js";
import { acceptFriction, registerFriction } from "./friction.js";
import { registerTts } from "./tts.js";

registerTts();
registerFriction();

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

async function submitChat(tab: chrome.tabs.Tab | undefined, message: string, fresh: boolean) {
  if (!message.trim()) return;
  await recordSubmittedRequest(message).catch(() => console.warn("Could not save the submitted request to local history."));
  if (tab) await agent.startRun(tab, "chat", message, fresh);
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
  if (command === "start-voice") {
    const target = tab ?? (await activeTab());
    if (target?.id !== undefined) await sendToTab(target.id, { kind: "startVoice" }).catch(() => undefined);
  }
  if (command === "open-debug") {
    const target = tab ?? (await activeTab());
    if (target?.windowId) await chrome.sidePanel.open({ windowId: target.windowId }).catch(() => undefined);
  }
});

async function maybeRunProactively(tab: chrome.tabs.Tab, origin: string) {
  const state = await load();
  if (!state.proactive || state.paused || !state.profile.length || !tab.id) return;
  const key = JSON.stringify([tab.id, origin, state.profile]);
  const { proactiveSeen = [] } = (await chrome.storage.session.get("proactiveSeen")) as { proactiveSeen?: string[] };
  if (proactiveSeen.includes(key)) return;
  if (await agent.startRun(tab, "page_load", "")) {
    const { proactiveSeen: seen = [] } = (await chrome.storage.session.get("proactiveSeen")) as { proactiveSeen?: string[] };
    await chrome.storage.session.set({ proactiveSeen: [...seen.filter((entry) => entry !== key).slice(-100), key] });
  }
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  if (handleVoiceRequest(request, sender, sendResponse)) return false;
  switch (request.kind) {
    case "runChat":
      if (sender.tab) void submitChat(sender.tab, request.message, request.fresh).finally(() => sendResponse());
      return !!sender.tab;
    case "deleteRequest":
      if (typeof request.message !== "string") return false;
      void removeSubmittedRequest(request.message).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    case "frictionAccept":
      if (sender.tab) void acceptFriction().catch(() => undefined);
      break;
    case "pageReady":
      if (sender.tab) void maybeRunProactively(sender.tab, request.origin);
      break;
    case "openDebug":
      if (sender.tab?.id) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => undefined);
      break;
    case "openShortcuts":
      void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      break;
    case "verifyVoice":
      if (sender.id !== chrome.runtime.id || typeof request.key !== "string" || request.key.length > 4096) return false;
      void requestAudio("verify", JSON.stringify(request.key ? { key: request.key } : {}), "application/json", AbortSignal.timeout(28_000))
        .then(() => sendResponse({ ok: true }), (error: Error) => sendResponse({
          ok: false,
          error: error instanceof TypeError ? "Could not reach the local audio server. Check that it is running." : error.message,
        }));
      return true;
    case "providerSetup":
      if (sender.url !== chrome.runtime.getURL("popup.html")) return false;
      void agent.configureProvider({ provider: request.provider, action: request.action, key: request.key })
        .then(() => sendResponse({ ok: true }), (error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
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
    if (request.type === "chat") await submitChat(await activeTab(), request.message, true);
  });
  port.onDisconnect.addListener(() => debugPorts.delete(port));
});

void agent.ensureConnected().catch(() => undefined);
