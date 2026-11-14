import { chunkForSpeech, cleanForSpeech } from "../../../shared/speech.js";
import type { TtsRequest, TtsStateMessage } from "../messages.js";
import { load } from "../storage.js";

export interface SpeakOptions {
  voiceName?: string;
  rate?: number;
  queue?: boolean;
  tabId?: number;
}

let session = 0;
let outstanding = 0;
let speaking = false;
let owner: number | undefined;

const TERMINAL = new Set(["end", "interrupted", "cancelled", "error"]);
const noop = () => undefined;

function setSpeaking(on: boolean) {
  if (speaking === on) return;
  speaking = on;
  const message: TtsStateMessage = { type: "tts-state", speaking: on };
  void chrome.runtime.sendMessage(message).catch(noop);
  if (owner !== undefined) void chrome.tabs.sendMessage(owner, message).catch(noop);
}

export function isSpeaking() {
  return speaking;
}

export function stop() {
  session++;
  outstanding = 0;
  chrome.tts.stop();
  setSpeaking(false);
}

export function speak(text: string, options: SpeakOptions = {}) {
  const chunks = chunkForSpeech(cleanForSpeech(text));
  if (!chunks.length) return;
  if (!options.queue) stop();
  owner = options.tabId;
  const mine = session;
  setSpeaking(true);
  chunks.forEach((chunk, index) => {
    let finished = false;
    const finish = () => {
      if (finished || mine !== session) return;
      finished = true;
      outstanding--;
      if (outstanding <= 0) setSpeaking(false);
    };
    outstanding++;
    chrome.tts.speak(
      chunk,
      {
        enqueue: options.queue || index > 0,
        voiceName: options.voiceName || undefined,
        rate: options.rate,
        onEvent: (event) => {
          if (TERMINAL.has(event.type)) finish();
        },
      },
      () => {
        if (chrome.runtime.lastError) finish();
      },
    );
  });
}

export function getVoices(): Promise<Array<{ voiceName: string; lang?: string }>> {
  return new Promise((resolve) => {
    chrome.tts.getVoices((voices) => {
      const named = voices.filter((voice): voice is typeof voice & { voiceName: string } => Boolean(voice.voiceName));
      resolve(named.map(({ voiceName, lang }) => ({ voiceName, lang })).sort((a, b) => a.voiceName.localeCompare(b.voiceName)));
    });
  });
}

export async function speakIfEnabled(text: string, tabId?: number) {
  const state = await load();
  if (!state.speakReplies || state.paused) return;
  speak(text, { voiceName: state.ttsVoice, rate: state.ttsRate, tabId });
}

export function registerTts() {
  chrome.runtime.onMessage.addListener((request: TtsRequest, sender, sendResponse) => {
    switch (request.type) {
      case "tts-speak":
        void (async () => {
          const state = await load();
          if (request.source === "reply" || request.source === "announce") {
            if (!state.speakReplies || state.paused) return;
          }
          speak(request.text, { voiceName: state.ttsVoice, rate: state.ttsRate, tabId: sender.tab?.id });
        })();
        return false;
      case "tts-stop":
        stop();
        return false;
      case "tts-voices":
        void getVoices().then((voices) => sendResponse({ voices }), () => sendResponse({ voices: [] }));
        return true;
      default:
        return false;
    }
  });
}
