import type { VoiceEvent } from "../voice/core.js";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface RecognitionErrorEvent {
  error: string;
}

interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognizerConstructor = new () => Recognizer;

interface RecognizerStatics {
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

const speech = globalThis as unknown as { SpeechRecognition?: RecognizerConstructor & RecognizerStatics; webkitSpeechRecognition?: RecognizerConstructor & RecognizerStatics };

let recognizer: Recognizer | null = null;

function emit(event: VoiceEvent) {
  void chrome.runtime.sendMessage({ target: "background", kind: "recognitionEvent", event }).catch(() => undefined);
}

async function preferOnDevice(Ctor: RecognizerStatics, lang: string): Promise<boolean> {
  if (typeof Ctor.available !== "function") return false;
  try {
    return (await Ctor.available({ langs: [lang], processLocally: true })) === "available";
  } catch {
    return false;
  }
}

async function start(requested: string) {
  const previous = recognizer;
  recognizer = null;
  previous?.abort();
  const Ctor = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
  if (!Ctor) {
    emit({ type: "error", error: "unsupported" });
    emit({ type: "ended" });
    return;
  }
  const lang = requested || navigator.language;
  const next = new Ctor();
  const session = { committed: "" };
  const current = () => recognizer === next;
  next.lang = lang;
  next.continuous = true;
  next.interimResults = true;
  next.processLocally = await preferOnDevice(Ctor, lang);
  next.onstart = () => current() && emit({ type: "listening" });
  next.onresult = (event) => {
    if (!current()) return;
    let pending = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) session.committed += result[0].transcript;
      else pending += result[0].transcript;
    }
    emit({ type: "interim", text: `${session.committed}${pending}`.trim() });
  };
  next.onerror = (event) => current() && emit({ type: "error", error: event.error });
  next.onend = () => {
    if (!current()) return;
    recognizer = null;
    emit({ type: "final", text: session.committed.trim() });
    emit({ type: "ended" });
  };
  recognizer = next;
  try {
    next.start();
  } catch {
    recognizer = null;
    emit({ type: "error", error: "start-failed" });
    emit({ type: "ended" });
  }
}

chrome.runtime.onMessage.addListener((message: { target?: string; kind?: string; lang?: string }) => {
  if (message?.target !== "offscreen") return;
  if (message.kind === "voiceStart") void start(message.lang ?? "");
  if (message.kind === "voiceStop") recognizer?.stop();
});
