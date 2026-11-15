import { requestAudio } from "../voice/audio-api.js";
import type { TargetElement } from "../../../shared/protocol.js";
import type { BackgroundRequest, ContentRequest, DebugPortMessage, DebugPortRequest, PageInspection, StatusInfo, UiEvent } from "../messages.js";
import { load, recordRequestSession, recordSubmittedRequest, removeSubmittedRequest, save, type RequestSession } from "../storage.js";
import { lastingRequest } from "../../../shared/validate.js";
import { settle } from "../coalesce.js";
import { AgentClient, sendToTab } from "./agent.js";
import { ProactiveClaims } from "./proactive-claims.js";
import { handleVoiceRequest } from "./voice.js";
import { registerFriction } from "./friction.js";
import { registerTts } from "./tts.js";
import { applyProfileAction, type ProfileAction } from "../profiles.js";

registerTts();
registerFriction();

const sessionRequests = new Map<string, { message: string; thread?: string; options?: RequestSession["options"] }>();
const debugPorts = new Set<chrome.runtime.Port>();

function broadcast(message: DebugPortMessage) {
  for (const port of debugPorts) port.postMessage(message);
}

const agent = new AgentClient({
  event(tabId: number, event: UiEvent) {
    if (event.type === "start" && event.trigger === "chat") sessionRequests.set(event.runId, { message: event.message, thread: event.thread });
    if (event.type === "cancelled") sessionRequests.delete(event.runId);
    if (event.type === "options") {
      const request = sessionRequests.get(event.runId);
      if (request) request.options = { question: event.question, options: event.options };
    }
    if (event.type === "start" && event.trigger === "page_load") proactive.noteStart(tabId, event.runId);
    if (event.type === "done" && event.trigger === "page_load") {
      const checked = proactive.finish(tabId, event.runId);
      if (checked) void markChecked(checked).finally(() => proactive.drop(checked));
    } else if (event.type === "error" || event.type === "cancelled") {
      const checked = proactive.finish(tabId, event.runId);
      if (checked) proactive.drop(checked);
    }
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
let switchingProfile = false;

async function changeProfile(action: ProfileAction) {
  if (switchingProfile) throw new Error("A profile is already switching. Try again shortly.");
  if (action.action === "rename") return applyProfileAction(action);
  if (action.action === "delete" && action.id !== (await load()).activeProfileId) return applyProfileAction(action);
  if (action.action === "switch" && action.id === (await load()).activeProfileId) return;
  switchingProfile = true;
  try {
    agent.stopForProfileSwitch();
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    // Let pending local changes finish before saving the outgoing layout.
    await Promise.allSettled(tabs.filter((tab) => tab.id).map((tab) => sendToTab(tab.id!, { kind: "prepareProfileSwitch" })));
    await applyProfileAction(action);
  } finally {
    switchingProfile = false;
  }
}

async function submitChat(tab: chrome.tabs.Tab | undefined, message: string, fresh: boolean, interrupt = false, thread?: string, target?: TargetElement) {
  if (switchingProfile) return;
  if (!message.trim()) return;
  const lasting = lastingRequest(message);
  await recordSubmittedRequest(lasting ?? message).catch(() => console.warn("Could not save the submitted request to local history."));
  if (lasting) await save({ lastingSuggestion: lasting }).catch(() => undefined);
  if (tab) await agent.startRun(tab, "chat", message, { fresh, interrupt, thread, target });
}

async function injectContent(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
}

// The setup page has no content script; it shows that the shortcut worked instead.
function onWelcomePage(tab: chrome.tabs.Tab | undefined, command: string) {
  if (!tab?.url?.startsWith(chrome.runtime.getURL("welcome.html"))) return false;
  void chrome.runtime.sendMessage({ kind: "welcomeShortcut", command }).catch(() => undefined);
  return true;
}

// Keys and the ChatGPT sign-in live on the server, so a reset here never signs the user out.
async function resetEverything() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear().catch(() => undefined);
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (tab.id) await sendToTab(tab.id, { kind: "resetPage" }).catch(() => undefined);
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
}

// Tabs opened before the extension was (re)loaded have no content script yet; a fresh one needs a moment to start listening.
async function reachTab(tabId: number, request: ContentRequest): Promise<boolean> {
  try {
    await sendToTab(tabId, request);
    return true;
  } catch {
    // fall through to injecting the content script
  }
  try {
    await injectContent(tabId);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await sendToTab(tabId, request);
      return true;
    } catch {
      // still starting up
    }
  }
  return false;
}

async function flagUnavailable(tabId: number) {
  await chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => undefined);
  await chrome.action.setTitle({ tabId, title: "The bar can't open on this page. Chrome blocks extensions here." }).catch(() => undefined);
  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    void chrome.action.setTitle({ tabId, title: "Cappy" }).catch(() => undefined);
  }, 4000);
}

async function openBarSettings(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id) return;
  if (!(await reachTab(tab.id, { kind: "openSettings" }))) await flagUnavailable(tab.id);
}

chrome.action.onClicked.addListener((tab) => void openBarSettings(tab));

async function toggleSpotlight(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id || onWelcomePage(tab, "toggle-spotlight")) return;
  if (!(await reachTab(tab.id, { kind: "toggleSpotlight" }))) await flagUnavailable(tab.id);
}

// An earlier version made the toolbar icon open the side panel, and Chrome persists that choice.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "adapt-element" && tab?.id) void sendToTab(tab.id, { kind: "targetContextElement" }).catch(() => undefined);
});

// An unpacked build keeps running old code after `build:ext` rewrites dist, while the server already speaks the new protocol.
// Reload once the files change and nothing is running; onInstalled then re-injects open tabs.
async function contentFingerprint(): Promise<string | null> {
  try {
    const text = await (await fetch(chrome.runtime.getURL("dist/content.js"), { cache: "no-store" })).text();
    return `${text.length}:${text.slice(-200)}`;
  } catch {
    return null;
  }
}

// Session storage outlives the worker going idle but not a reload, so it holds what this build looked like at install.
async function reloadIfRebuilt() {
  const current = await contentFingerprint();
  if (!current) return;
  const { builtFingerprint } = (await chrome.storage.session.get("builtFingerprint")) as { builtFingerprint?: string };
  if (!builtFingerprint) return void chrome.storage.session.set({ builtFingerprint: current });
  if (current !== builtFingerprint && !agent.status.busy) chrome.runtime.reload();
}

if (!("update_url" in chrome.runtime.getManifest())) {
  void reloadIfRebuilt();
  setInterval(() => void reloadIfRebuilt(), 5000);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const built = await contentFingerprint();
  if (built) await chrome.storage.session.set({ builtFingerprint: built });
  if (reason === "install" && !(await load()).onboarded) void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  chrome.contextMenus.create({ id: "adapt-element", title: "Adapt this with Cappy", contexts: ["all"] }, () => void chrome.runtime.lastError);
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (tab.id) void injectContent(tab.id).catch(() => undefined);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-spotlight") await toggleSpotlight(tab ?? (await activeTab()));
  if (command === "start-voice") {
    const target = tab ?? (await activeTab());
    if (onWelcomePage(target, "start-voice")) return;
    if (target?.id !== undefined) await sendToTab(target.id, { kind: "startVoice" }).catch(() => undefined);
  }
  if (command === "open-debug") {
    const target = tab ?? (await activeTab());
    if (target?.windowId) await chrome.sidePanel.open({ windowId: target.windowId }).catch(() => undefined);
  }
});

const CHECKED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
// Origin+profile keys whose page-load check has started but not finished. Two tabs must not both call the model.
const proactive = new ProactiveClaims();

const checkedKey = (state: { activeProfileId: string; profile: string[] }, origin: string) => JSON.stringify([state.activeProfileId, origin, state.profile]);

async function markChecked(key: string) {
  const { proactiveChecked = {} } = (await chrome.storage.local.get("proactiveChecked")) as { proactiveChecked?: Record<string, number> };
  const now = Date.now();
  const kept = Object.entries(proactiveChecked).filter(([, at]) => now - at < CHECKED_FOR_MS).slice(-500);
  await chrome.storage.local.set({ proactiveChecked: Object.fromEntries([...kept, [key, now]]) });
}

async function checkedRecently(key: string) {
  const { proactiveChecked = {} } = (await chrome.storage.local.get("proactiveChecked")) as { proactiveChecked?: Record<string, number> };
  const at = proactiveChecked[key];
  return at !== undefined && Date.now() - at < CHECKED_FOR_MS;
}

// A page or site with its own saved changes was already adapted without a model call. Global changes alone do not count,
// since cross-site preferences such as a content filter still need a site-specific implementation here.
// A site this profile already checked in the last week is skipped too, in any tab: its changes, if any, were saved then.
async function maybeRunProactively(tab: chrome.tabs.Tab, origin: string, restored: number, profileChanged = false) {
  const state = await load();
  const adaptedHere = restored > 0;
  if (!tab.id) return;
  const tabId = tab.id;
  const note = (text: string) => sendToTab(tabId, { kind: "activity", text }).catch(() => undefined);
  const skipReason = state.paused ? "adaptations are paused" : !state.proactive && !profileChanged ? "Act on page load is off" : !state.profile.length ? "profile is empty" : adaptedHere ? "saved site changes were restored" : null;
  if (skipReason) {
    await note(`Automatic page adaptation skipped: ${skipReason}.`);
    return;
  }
  const key = JSON.stringify([tab.id, origin, state.activeProfileId, state.profile]);
  const { proactiveSeen = [] } = (await chrome.storage.session.get("proactiveSeen")) as { proactiveSeen?: string[] };
  if (!profileChanged && proactiveSeen.includes(key)) {
    await note("Automatic page adaptation skipped: already checked this site and profile in this tab during this browser session.");
    return;
  }
  const checked = checkedKey(state, origin);
  if (!proactive.begin(tabId, checked)) {
    await note("Automatic page adaptation skipped: another tab is already checking this site.");
    return;
  }
  if (!profileChanged && (await checkedRecently(checked))) {
    proactive.release(tabId, checked);
    await note("Automatic page adaptation skipped: this profile already checked this site in the last week.");
    return;
  }
  // Asking first costs nothing until the user accepts; the offer counts as this week's check so it does not repeat on every visit.
  if (state.askBeforeAdapting && !profileChanged) {
    await markChecked(checked);
    proactive.release(tabId, checked);
    await sendToTab(tabId, { kind: "offerAdapt" }).catch(() => undefined);
    await note("Offered to adapt this page instead of adapting it automatically.");
    return;
  }
  if ((await agent.startRun(tab, "page_load", "")) === "started") {
    await note("Automatic page adaptation started: enabled, profile present, no saved site adaptation, first check for this site and profile in this tab.");
    const { proactiveSeen: seen = [] } = (await chrome.storage.session.get("proactiveSeen")) as { proactiveSeen?: string[] };
    await chrome.storage.session.set({ proactiveSeen: [...seen.filter((entry) => entry !== key).slice(-100), key] });
  } else {
    proactive.release(tabId, checked);
  }
}

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  if (handleVoiceRequest(request, sender, sendResponse)) return false;
  switch (request.kind) {
    case "profileAction":
      void changeProfile(request).then(() => sendResponse({ ok: true }), (error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case "runChat":
      if (sender.tab) void submitChat(sender.tab, request.message, request.fresh, request.interrupt, request.thread, request.target).finally(() => sendResponse());
      return !!sender.tab;
    case "deleteRequest":
      if (typeof request.message !== "string") return false;
      void removeSubmittedRequest(request.message).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    case "pageReady":
      if (switchingProfile && !request.profileChanged) break;
      if (sender.tab) {
        void agent.runEverywhereCommands(sender.tab, request.origin);
        void maybeRunProactively(sender.tab, request.origin, request.restored, request.profileChanged);
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
    case "openWelcome":
      void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
      break;
    case "resetAll":
      void resetEverything().then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    case "status":
      void settle(
        agent.ensureConnected({ probe: true }).catch(() => undefined).then(() => agent.getStatus()),
        { connected: false, busy: false },
        8_000,
      ).then(sendResponse);
      return true;
    case "setKey":
      void agent.setKey(request.provider, request.key).catch(() => undefined);
      break;
    case "chatgptLogin":
      void agent.signIn().catch(() => undefined);
      break;
    case "suggest":
      void agent.suggest(request.page, request.applied, request.friction, sender.tab?.id).then(sendResponse);
      return true;
    case "classify":
      void agent.classify(request.match, request.items).then(sendResponse);
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
    if (request.type === "inspect") {
      try {
        const tab = await activeTab();
        if (!tab?.id || !tab.url?.startsWith("http")) throw new Error("Select a web page to inspect.");
        const snapshot = await sendToTab<PageInspection>(tab.id, { kind: "inspectPage" });
        port.postMessage({ type: "inspection", snapshot } satisfies DebugPortMessage);
      } catch (error) {
        port.postMessage({ type: "inspection", error: error instanceof Error ? error.message : String(error) } satisfies DebugPortMessage);
      }
      return;
    }
    if (request.type === "chat") await submitChat(await activeTab(), request.message, true, false, request.thread);
  });
  port.onDisconnect.addListener(() => debugPorts.delete(port));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.provider) void agent.ensureModels();
});

void agent.ensureConnected().catch(() => undefined);
