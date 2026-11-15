import { requestAudio } from "../voice/audio-api.js";
import type { VoiceEvent } from "../voice/core.js";
import { ENDPOINT, startEndpoint, stepEndpoint, stripDoneKeyword } from "../voice/endpoint.js";
import { floatToPcm16, LIVE_RATE, liveUrl, parseLiveMessage, pcm16ToFloat } from "../voice/pcm.js";
import type { LiveFromClient } from "../../../shared/protocol.js";

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
let stopMeter: (() => void) | null = null;
let stopSpotter: (() => void) | null = null;
const METER_MS = 50;
// Automatic gain raises room noise as soon as the user stops talking, which hides the pause; noise suppression helps too.
const MIC: MediaStreamConstraints = { audio: { autoGainControl: false, noiseSuppression: true, echoCancellation: true } };

// Cloud transcription returns text only at the end, so "done" is spotted live with Chrome's on-device recognizer, never its server one.
async function spotDone(lang: string, onDone: () => void) {
  stopSpotter?.();
  const Ctor = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
  if (!Ctor || !(await preferOnDevice(Ctor, lang || navigator.language))) return;
  const spotter = new Ctor();
  spotter.lang = lang || navigator.language;
  spotter.continuous = true;
  spotter.interimResults = true;
  spotter.processLocally = true;
  let heard = "";
  spotter.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
    heard = text;
    if (stripDoneKeyword(heard).done) onDone();
  };
  spotter.onerror = () => undefined;
  spotter.onend = () => undefined;
  const stop = () => {
    spotter.onresult = null;
    try {
      spotter.abort();
    } catch {
      // already stopped
    }
    if (stopSpotter === stop) stopSpotter = null;
  };
  stopSpotter = stop;
  try {
    spotter.start();
  } catch {
    stop();
  }
}

function stopListening() {
  if (recording?.state === "recording") recording.stop();
  recognizer?.stop();
}

// Measures loudness every 50 ms and ends listening after a pause, when nothing is said, or at the cap.
function meter(stream: MediaStream, hold: boolean) {
  stopMeter?.();
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let state = startEndpoint(Date.now());
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const step = stepEndpoint(state, Math.sqrt(sum / samples.length), Date.now(), hold);
    state = step.state;
    if (!step.signal) return;
    if (step.signal.type === "stop") {
      if (step.signal.reason === "no-speech") emit({ type: "error", error: "no-speech" });
      cleanup();
      stopListening();
    } else emit(step.signal);
  }, METER_MS);
  const cleanup = () => {
    clearInterval(timer);
    void context.close().catch(() => undefined);
    if (stopMeter === cleanup) stopMeter = null;
  };
  stopMeter = cleanup;
}

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

async function start(requested: string, hold: boolean) {
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
    const heard = stripDoneKeyword(`${session.committed}${pending}`);
    emit({ type: "interim", text: heard.text });
    if (heard.done) {
      session.committed = heard.text;
      next.stop();
    }
  };
  next.onerror = (event) => current() && emit({ type: "error", error: event.error });
  next.onend = () => {
    if (!current()) return;
    recognizer = null;
    stopMeter?.();
    meterStream?.getTracks().forEach((track) => track.stop());
    emit({ type: "final", text: stripDoneKeyword(session.committed).text });
    emit({ type: "ended" });
  };
  recognizer = next;
  // The recognizer has no loudness signal of its own, so a second, local-only stream feeds the pause detector.
  const meterStream = await navigator.mediaDevices.getUserMedia(MIC).catch(() => undefined);
  if (!current()) {
    meterStream?.getTracks().forEach((track) => track.stop());
    return;
  }
  if (meterStream) meter(meterStream, hold);
  else setTimeout(() => current() && next.stop(), ENDPOINT.maxMs);
  try {
    next.start();
  } catch {
    stopMeter?.();
    meterStream?.getTracks().forEach((track) => track.stop());
    recognizer = null;
    emit({ type: "error", error: "start-failed" });
    emit({ type: "ended" });
  }
}

let recording: MediaRecorder | undefined;
let recordingTimer: ReturnType<typeof setTimeout> | undefined;
let playback: AbortController | undefined;
let player: HTMLAudioElement | undefined;

async function record(provider: "openai" | "gemini", serverUrl: string, hold: boolean, lang: string) {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia(MIC);
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    const chunks: Blob[] = [];
    recording = recorder;
    recorder.ondataavailable = ({ data }) => chunks.push(data);
    recorder.onerror = () => {
      emit({ type: "error", error: "start-failed" });
      if (recorder.state !== "inactive") recorder.stop();
    };
    recorder.onstop = async () => {
      clearTimeout(recordingTimer);
      stopMeter?.();
      stopSpotter?.();
      stream?.getTracks().forEach((track) => track.stop());
      if (recording !== recorder) return;
      try {
        const response = await requestAudio("transcribe", new Blob(chunks, { type: "audio/webm" }), "audio/webm", AbortSignal.timeout(25_000), provider, serverUrl);
        const { text } = await response.json() as { text: string };
        emit({ type: "final", text: stripDoneKeyword(text).text });
      } catch {
        emit({ type: "error", error: provider === "gemini" ? "gemini-audio" : "openai-audio" });
      } finally {
        recording = undefined;
        emit({ type: "ended" });
      }
    };
    recorder.start();
    emit({ type: "listening" });
    meter(stream, hold);
    void spotDone(lang, () => {
      stopMeter?.();
      if (recorder.state === "recording") recorder.stop();
    });
    recordingTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, ENDPOINT.maxMs);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    recording = undefined;
    const code = error instanceof DOMException ? {
      NotAllowedError: "not-allowed",
      SecurityError: "not-allowed",
      NotFoundError: "audio-capture",
      NotReadableError: "microphone-unavailable",
      AbortError: "microphone-unavailable",
    }[error.name] : undefined;
    emit({ type: "error", error: code ?? "start-failed" });
    emit({ type: "ended" });
  }
}

// A GPT-Live conversation: the microphone streams to the server, the reply audio plays back, and page requests go to the agent.
const LIVE_IDLE_MS = 3 * 60_000;
const LIVE_MAX_MS = 20 * 60_000;
let stopLive: ((error?: string) => void) | null = null;

function micError(error: unknown): string {
  const code = error instanceof DOMException ? {
    NotAllowedError: "not-allowed",
    SecurityError: "not-allowed",
    NotFoundError: "audio-capture",
    NotReadableError: "microphone-unavailable",
    AbortError: "microphone-unavailable",
  }[error.name] : undefined;
  return code ?? "start-failed";
}

async function startLive(serverUrl: string) {
  stopLive?.();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(MIC);
  } catch (error) {
    emit({ type: "error", error: micError(error) });
    emit({ type: "ended" });
    return;
  }
  const context = new AudioContext({ sampleRate: LIVE_RATE });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  const socket = new WebSocket(liveUrl(serverUrl));
  socket.binaryType = "arraybuffer";
  const playing = new Set<AudioBufferSourceNode>();
  let playAt = 0;
  let ready = false;
  let heardAt = Date.now();
  let stopped = false;

  const flushPlayback = () => {
    for (const node of playing) {
      try {
        node.stop();
      } catch {
        // already finished
      }
    }
    playing.clear();
    playAt = 0;
  };
  const stop = (error?: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(idle);
    flushPlayback();
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    if (stopLive === stop) stopLive = null;
    if (error) emit({ type: "error", error });
    emit({ type: "ended" });
  };
  stopLive = stop;
  const startedAt = Date.now();
  const idle = setInterval(() => {
    if (Date.now() - heardAt > LIVE_IDLE_MS || Date.now() - startedAt > LIVE_MAX_MS) stop();
  }, 5_000);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    event.outputBuffer.getChannelData(0).fill(0);
    if (!ready || socket.readyState !== WebSocket.OPEN) return;
    socket.send(floatToPcm16(input));
  };
  source.connect(processor);
  processor.connect(context.destination);

  const play = (bytes: ArrayBuffer) => {
    const samples = pcm16ToFloat(bytes);
    if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, LIVE_RATE);
    buffer.copyToChannel(samples, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    playAt = Math.max(playAt, context.currentTime + 0.05);
    node.start(playAt);
    playAt += buffer.duration;
    playing.add(node);
    node.onended = () => playing.delete(node);
  };

  socket.onmessage = (message) => {
    if (message.data instanceof ArrayBuffer) return play(message.data);
    const event = parseLiveMessage(String(message.data));
    if (!event) return;
    if (event.type === "ready") {
      ready = true;
      emit({ type: "listening" });
    } else if (event.type === "heard") {
      heardAt = Date.now();
      // Talking over the reply cuts it off. GPT-Live stops on its own, but audio it already sent is still queued here.
      // Its transcript, not microphone loudness, says the user is talking, so Cappy's own voice through speakers does not count.
      if (event.text && playing.size) flushPlayback();
      emit({ type: "interim", text: event.text });
    } else if (event.type === "task") {
      const id = event.id;
      heardAt = Date.now();
      void chrome.runtime.sendMessage({ target: "background", kind: "liveTask", id, text: event.text })
        .then((reply: { text?: string } | undefined) => reply?.text ?? "Done.", () => "That did not work. Nothing was changed.")
        .then((text) => {
          const result: LiveFromClient = { type: "result", id, text };
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
        });
    } else if (event.type === "error") {
      stop("live-unavailable");
    } else if (event.type === "closed") {
      stop();
    }
  };
  socket.onerror = () => stop("live-unavailable");
  socket.onclose = () => stop();
}

function stopPlayback() {
  playback?.abort();
  player?.pause();
}

async function playSpeech(text: string, rate: number, provider: "openai" | "gemini", serverUrl: string) {
  stopPlayback();
  const controller = new AbortController();
  playback = controller;
  let url: string | undefined;
  try {
    const response = await requestAudio("speech", JSON.stringify({ text, rate }), "application/json", AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), provider, serverUrl);
    const blob = await response.blob();
    controller.signal.throwIfAborted();
    url = URL.createObjectURL(blob);
    const element = new Audio(url);
    if (provider === "gemini") element.playbackRate = rate;
    player = element;
    await new Promise<void>((resolve, reject) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
      element.onended = () => resolve();
      element.onerror = () => reject(new Error("Could not play speech"));
      void element.play().catch(reject);
    });
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (playback === controller) {
      playback = undefined;
      player = undefined;
    }
  }
}

chrome.runtime.onMessage.addListener((message: { target?: string; kind?: string; lang?: string; hold?: boolean; text?: string; rate?: number; provider?: "openai" | "gemini"; voiceProvider?: "chrome" | "openai" | "gemini" | "live"; serverUrl?: string }, _sender, respond) => {
  if (message?.target !== "offscreen") return;
  if (message.kind === "voiceStart") {
    respond(true);
    const voiceProvider = message.voiceProvider ?? "chrome";
    void Promise.resolve().then(async () => {
      const permission = await Promise.resolve().then(() => navigator.permissions.query({ name: "microphone" })).catch(() => undefined);
      if (permission && permission.state !== "granted" && voiceProvider === "chrome") {
        emit({ type: "error", error: "microphone-setup" });
        return;
      }
      const hold = message.hold === true;
      if (voiceProvider === "live") return startLive(message.serverUrl ?? "");
      await (voiceProvider === "chrome" ? start(message.lang ?? "", hold) : record(voiceProvider, message.serverUrl ?? "", hold, message.lang ?? ""));
    }).catch(() => {
      emit({ type: "error", error: "start-failed" });
      emit({ type: "ended" });
    });
  }
  if (message.kind === "voiceStop") {
    stopLive?.();
    stopMeter?.();
    stopSpotter?.();
    stopListening();
  }
  if (message.kind === "speechStop") stopPlayback();
  if (message.kind === "speechPlay" && typeof message.text === "string") {
    void playSpeech(message.text, message.rate ?? 1, message.provider ?? "openai", message.serverUrl ?? "").then(() => respond(true), () => respond(false));
    return true;
  }
});
