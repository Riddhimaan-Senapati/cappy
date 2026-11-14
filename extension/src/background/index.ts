import { requestAudio } from "../voice/audio-api.js";
import type { BackgroundRequest, DebugPortMessage, DebugPortRequest, StatusInfo, UiEvent } from "../messages.js";
import { load, recordRequestSession, recordSubmittedRequest, removeSubmittedRequest } from "../storage.js";
import { AgentClient, sendToTab } from "./agent.js";
import { handleVoiceRequest } from "./voice.js";
import { acceptFriction, registerFriction } from "./friction.js";
import { registerTts } from "./tts.js";

registerTts();
registerFriction();

const sessionRequests = new Map<string, { message: string; thread?: string }>();
const debugPorts = new Set<chrome.runtime.Port>();

function broadcast(message: DebugPortMessage) {
  for (const port of debugPorts) port.postMessage(message);
}

const agent = new AgentClient({
  event(tabId: number, event: UiEvent) {
    if (event.type === "start" && event.trigger === "chat") sessionRequests.set(event.runId, { message: event.message, thread: event.thread });
    if (event.type === "cancelled") sessionRequests.delete(event.runId);
    if (event.type === "done" || event.type === "error") {
      const message = sessionRequests.get(event.runId);
      sessionRequests.delete(event.runId);
      if (message !== undefined) {
        void recordRequestSession({ ...message, reply: event.type === "done" ? event.reply : event.message, outcome: event.type })
          .catch(() => console.warn("Could not save request session history."));
      }
    }
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

async function submitChat(tab: chrome.tabs.Tab | undefined, message: string, fresh: boolean, interrupt = false, thread?: string) {
  if (!message.trim()) return;
  await recordSubmittedRequest(message).catch(() => console.warn("Could not save the submitted request to local history."));
  if (tab) await agent.startRun(tab, "chat", message, { fresh, interrupt, thread });
}

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

chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (tab.id) void injectContent(tab.id).catch(() => undefined);
  }
});

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

// A site with its own saved changes was already adapted without a model call. Global changes alone do not count,
// since cross-site preferences such as a content filter still need a site-specific implementation here.
async function maybeRunProactively(tab: chrome.tabs.Tab, origin: string, restored: number) {
  const state = await load();
  const adaptedHere = restored > 0 && (state.siteChanges[origin]?.length ?? 0) > 0;
  if (!state.proactive || state.paused || !state.profile.length || adaptedHere || !tab.id) return;
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
      if (sender.tab) void submitChat(sender.tab, request.message, request.fresh, request.interrupt, request.thread).finally(() => sendResponse());
      return !!sender.tab;
    case "deleteRequest":
      if (typeof request.message !== "string") return false;
      void removeSubmittedRequest(request.message).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    case "frictionAccept":
      if (sender.tab) void acceptFriction(sender.tab).catch(() => undefined);
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
    case "verifyVoice":
      if (sender.id !== chrome.runtime.id || typeof request.key !== "string" || request.key.length > 4096) return false;
      void requestAudio("verify", JSON.stringify(request.key ? { key: request.key } : {}), "application/json", AbortSignal.timeout(28_000), request.provider)
        .then(() => sendResponse({ ok: true }), (error: Error) => sendResponse({
          ok: false,
          error: error instanceof TypeError ? "Could not reach the local audio server. Check that it is running." : error.message,
        }));
      return true;
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
  port.onMessage.addListener(async (request: DebugPortRequest) => {
    if (request.type === "chat") await submitChat(await activeTab(), request.message, true, false, request.thread);
  });
  port.onDisconnect.addListener(() => debugPorts.delete(port));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.provider) void agent.ensureModels();
});

void agent.ensureConnected().catch(() => undefined);
