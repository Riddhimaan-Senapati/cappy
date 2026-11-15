import { load } from "../storage.js";
import type { BackgroundRequest } from "../messages.js";
import { parseVoiceEvent, type VoiceEvent } from "../voice/core.js";

type Owner = { tabId: number } | { panel: true };

const OFFSCREEN_PATH = "offscreen.html";
let owner: Owner | null = null;
let language = "";
let hold = false;
let setupTab: number | undefined;
let permissionRetried = false;
let openingSetup = false;
let live = false;
// Runs a request heard in a GPT-Live conversation on the tab that started voice, and resolves with what to say back.
let liveTaskRunner: ((tabId: number, text: string) => Promise<string>) | null = null;

export function setLiveTaskRunner(runner: (tabId: number, text: string) => Promise<string>) {
  liveTaskRunner = runner;
}

export function liveActive(): boolean {
  return live && owner !== null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== setupTab) return;
  setupTab = undefined;
  deliver({ type: "ended" });
  owner = null;
});

let opening: Promise<void> | undefined;

export function ensureOffscreen() {
  opening ??= createOffscreen().finally(() => { opening = undefined; });
  return opening;
}

async function createOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Runs Chrome's speech recognition for voice input the user starts from the bar or side panel.",
  });
}

function deliver(event: VoiceEvent) {
  const message = { kind: "voiceEvent", event } as const;
  if (!owner) return;
  if ("tabId" in owner) void chrome.tabs.sendMessage(owner.tabId, message).catch(() => undefined);
  else void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function openMicSetup() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
}

async function startRecognition() {
  try {
    await ensureOffscreen();
    const { voiceProvider, serverUrl } = await load();
    live = voiceProvider === "live";
    if (owner) await chrome.runtime.sendMessage({ target: "offscreen", kind: "voiceStart", lang: language, hold, voiceProvider, serverUrl });
  } catch {
    deliver({ type: "error", error: "start-failed" });
    owner = null;
  }
}

async function onRecognitionEvent(raw: unknown) {
  const event = parseVoiceEvent(raw);
  if (!event) return;
  if (event.type === "error" && ["microphone-setup", "not-allowed"].includes(event.error) && owner && !permissionRetried) {
    permissionRetried = true;
    openingSetup = true;
    try {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html?resume=1") });
      setupTab = tab.id;
    } catch {
      deliver({ type: "error", error: "start-failed" });
      owner = null;
    } finally {
      openingSetup = false;
    }
    return;
  }
  if ((openingSetup || setupTab !== undefined) && (event.type === "ended" || event.type === "final")) return;
  deliver(event);
  if (event.type === "ended" || (event.type === "error" && event.error === "microphone-setup")) {
    owner = null;
    live = false;
  }
}

export function handleVoiceRequest(request: BackgroundRequest, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void): boolean {
  switch (request.kind) {
    case "liveTask": {
      // Only the extension's own offscreen document speaks for a live session.
      if (sender.id !== chrome.runtime.id || sender.tab) return false;
      const tabId = owner && "tabId" in owner ? owner.tabId : undefined;
      if (tabId === undefined || !liveTaskRunner || typeof request.text !== "string") {
        respond({ text: "Open a web page first, then ask again." });
        return true;
      }
      void liveTaskRunner(tabId, request.text.slice(0, 1_000)).then(
        (text) => respond({ text }),
        () => respond({ text: "That did not work. Nothing was changed." }),
      );
      return true;
    }
    case "voiceStart":
      if (owner) {
        respond(false);
        return true;
      }
      owner = sender.url !== chrome.runtime.getURL("sidepanel.html") && sender.tab?.id !== undefined
        ? { tabId: sender.tab.id } : { panel: true };
      permissionRetried = false;
      language = request.lang;
      hold = request.hold === true;
      respond(true);
      void startRecognition();
      return true;
    case "voicePermissionGranted": {
      if (sender.tab?.id === undefined || sender.tab.id !== setupTab || sender.url !== chrome.runtime.getURL("mic.html?resume=1")) return true;
      const tabId = setupTab;
      setupTab = undefined;
      const target = owner;
      void chrome.tabs.remove(tabId).catch(() => undefined).then(async () => {
        if (target && "tabId" in target) await chrome.tabs.update(target.tabId, { active: true });
        await startRecognition();
      }).catch(() => {
        deliver({ type: "error", error: "start-failed" });
        owner = null;
      });
      return true;
    }
    case "voiceStop":
      if (setupTab !== undefined) {
        void chrome.tabs.remove(setupTab).catch(() => undefined);
        return true;
      }
      void chrome.runtime.sendMessage({ target: "offscreen", kind: "voiceStop" }).catch(() => undefined);
      return true;
    case "voiceOpenMic":
      void openMicSetup().catch(() => undefined);
      return true;
    case "recognitionEvent":
      void onRecognitionEvent(request.event);
      return true;
    default:
      return false;
  }
}
