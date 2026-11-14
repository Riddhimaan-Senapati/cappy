import type { BackgroundRequest } from "../messages.js";
import { parseVoiceEvent, type VoiceEvent } from "../voice/core.js";

type Owner = { tabId: number } | { panel: true };

const OFFSCREEN_PATH = "offscreen.html";
let owner: Owner | null = null;
let language = "";
let setupTab: number | undefined;
let permissionRetried = false;
let openingSetup = false;

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
    if (owner) await chrome.runtime.sendMessage({ target: "offscreen", kind: "voiceStart", lang: language });
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
  }
}

export function handleVoiceRequest(request: BackgroundRequest, sender: chrome.runtime.MessageSender, respond: (accepted: boolean) => void): boolean {
  switch (request.kind) {
    case "voiceStart":
      if (owner) {
        respond(false);
        return true;
      }
      owner = sender.url !== chrome.runtime.getURL("sidepanel.html") && sender.tab?.id !== undefined
        ? { tabId: sender.tab.id } : { panel: true };
      permissionRetried = false;
      language = request.lang;
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
