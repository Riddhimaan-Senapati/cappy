import type { BackgroundRequest } from "../messages.js";
import { parseVoiceEvent, type VoiceEvent } from "../voice/core.js";

type Owner = { tabId: number } | { panel: true };

const OFFSCREEN_PATH = "offscreen.html";
let owner: Owner | null = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
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

async function onRecognitionEvent(raw: unknown) {
  const event = parseVoiceEvent(raw);
  if (!event) return;
  if (event.type === "error" && event.error === "not-allowed") await openMicSetup().catch(() => undefined);
  deliver(event);
  if (event.type === "ended") {
    owner = null;
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

export function handleVoiceRequest(request: BackgroundRequest, sender: chrome.runtime.MessageSender): boolean {
  switch (request.kind) {
    case "voiceStart":
      owner = sender.tab?.id !== undefined ? { tabId: sender.tab.id } : { panel: true };
      void ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ target: "offscreen", kind: "voiceStart", lang: request.lang }))
        .catch(() => {
          deliver({ type: "error", error: "unsupported" });
          deliver({ type: "ended" });
          owner = null;
        });
      return true;
    case "voiceStop":
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
