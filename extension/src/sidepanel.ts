import type { ContentRequest, DebugPortMessage, DebugPortRequest, StatusInfo, TtsRequest, TtsStateMessage, UiEvent } from "./messages.js";
import { cappyLogo, adoptStyles, h, icon } from "./ui/dom.js";
import { usageCard, USAGE_CSS } from "./ui/usage.js";
import { renderInspection, INSPECTION_CSS } from "./ui/inspection.js";
import { TOKENS } from "./ui/theme.js";
import { paintCountdown, paintMic, liveRegion, micButton } from "./voice/button.js";
import { VoiceController } from "./voice/controller.js";
import { joinVoiceText, parseVoiceEvent, voiceStatusText, type VoiceState } from "./voice/core.js";
import { VOICE_CSS } from "./voice/styles.js";
import { deleteRequest, findRequestSessions, load, suggestRequests, type StoredState } from "./storage.js";
import { outcomeText, scopeChoices } from "./ui/memory-choice.js";
import type { MemoryScope } from "../../shared/protocol.js";

function memoryChoice(line: string, host: string | undefined, scope: MemoryScope | undefined): HTMLElement {
  const item = h("li", "info memory-choice", `Save "${line}"? `);
  for (const choice of scopeChoices([line], host, scope)) {
    const button = h("button", choice.suggested ? "suggested" : "", choice.label);
    button.type = "button";
    button.addEventListener("click", async () => {
      const outcome = await choice.run();
      item.className = outcome.saved ? "good" : "info";
      item.textContent = `${outcomeText(outcome, host)}: ${line}`;
    });
    item.append(button);
  }
  return item;
}

const CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; background: #121217; }
body { box-sizing: border-box; font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); }
main { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px; }
[hidden] { display: none !important; }
main > * { flex-shrink: 0; }
.alert { margin: 0; color: var(--bad); font-size: 12px; }
h1 { margin: 0; font-size: 15px; letter-spacing: -0.01em; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.head-title { display: flex; align-items: center; gap: 8px; }
.head-title .cappy-logo { width: 22px; height: 22px; border-radius: 6px; }
.status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
.dot.on { background: var(--good); } .dot.off { background: var(--bad); }
.tts { display: flex; gap: 8px; } .tts button[hidden] { display: none; }
.memory-choice { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.memory-choice button.suggested { font-weight: 600; }
.timeline { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }
.run { padding: 12px; border-radius: 14px; background: var(--raise); border: 1px solid var(--line); animation: rise 0.3s var(--spring); }
.run .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.run .msg { flex: 1; font-weight: 600; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--raise2); color: var(--muted); }
.tag.fast { color: #bfe3ff; background: rgba(110, 168, 255, 0.2); } .tag.frontier { color: #ead9ff; background: rgba(167, 139, 250, 0.24); }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
.steps .good { color: var(--good); } .steps .warn { color: var(--warn); } .steps .bad { color: var(--bad); }
.reply { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.tools { max-height: 24%; overflow: auto; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); border-top: 1px solid var(--line); padding-top: 8px; }
.tools div { display: flex; gap: 8px; } .tools .bad { color: var(--bad); } .tools .ms { color: var(--muted); min-width: 54px; }
form { display: flex; gap: 8px; }
.previous-requests { display: grid; gap: 4px; }
.previous-request button.delete-request { color: #f87171; }
.previous-requests[hidden] { display: none; }
.previous-request { display: flex; gap: 4px; }
.previous-request button:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.previous-requests button { padding: 8px 12px; background: var(--raise); color: var(--text); text-align: left; }
textarea { flex: 1; resize: none; padding: 10px 12px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); color: var(--text); font: inherit; outline: none; }
textarea:focus { border-color: var(--accent); }
button { padding: 0 16px; min-height: 24px; border: 0; border-radius: 12px; background: var(--grad); color: #0d0d12; font-weight: 650; cursor: pointer; }
.inspect summary { min-height: 24px; display: flex; align-items: center; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
@media (forced-colors: active) {
  :focus-visible, button:focus-visible, textarea:focus { outline: 2px solid Highlight; outline-offset: 2px; }
  button, textarea, .run, .previous-requests button { border: 1px solid ButtonText; }
  button[aria-pressed="true"], .head-actions button[aria-pressed="true"] { outline: 2px solid Highlight; outline-offset: 2px; }
  .memory-choice button.suggested { outline: 1px dashed ButtonText; }
  .dot { border: 1px solid ButtonText; }
}
`;

adoptStyles(document, TOKENS + USAGE_CSS + CSS + VOICE_CSS + INSPECTION_CSS);

const statusDot = h("span", "dot");
const statusText = h("span", "", "Connecting");
const statusLine = h("div", "status", "", [statusDot, statusText]);
statusLine.setAttribute("role", "status");
const alertText = h("p", "alert");
alertText.setAttribute("role", "alert");
alertText.hidden = true;
function showAlert(text: string) {
  alertText.textContent = text;
  alertText.hidden = !text;
}
const usage = h("div");
const refreshUsage = async () => usage.replaceChildren(usageCard((await load()).usage));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.usage) void refreshUsage();
});
void refreshUsage();
const timeline = h("div", "timeline");
timeline.setAttribute("role", "log");
timeline.setAttribute("aria-label", "Runs");
const tools = h("div", "tools");
const inspector = h("div", "inspect");
inspector.hidden = true;
const inspectButton = h("button", "", "Inspect");
inspectButton.type = "button";
inspectButton.setAttribute("aria-pressed", "false");
const backButton = h("button", "", "Activity");
backButton.type = "button";
backButton.hidden = true;
function showInspection(on: boolean) {
  inspector.hidden = !on;
  usage.hidden = on;
  form.hidden = on;
  if (on) previousRequests.hidden = true;
  else renderPreviousRequests();
  playbackControls.hidden = on;
  timeline.hidden = on;
  tools.hidden = on;
  backButton.hidden = !on;
  inspectButton.textContent = on ? "Refresh inspect" : "Inspect";
  inspectButton.setAttribute("aria-pressed", String(on));
}
inspectButton.addEventListener("click", () => {
  showInspection(true);
  inspector.replaceChildren(h("p", "", "Reading the active page…"));
  port.postMessage({ type: "inspect" } satisfies DebugPortRequest);
});
backButton.addEventListener("click", () => showInspection(false));
const input = h("textarea");
input.rows = 2;
input.placeholder = "Debug chat: runs on the active tab, always asks the AI fresh";
input.setAttribute("aria-label", "Debug chat message");
const mic = micButton();
const live = liveRegion();
const form = h("form", "", "", [input, mic, h("button", "", "Send")]);
const previousRequests = h("div", "previous-requests");
previousRequests.setAttribute("role", "group");
previousRequests.setAttribute("aria-label", "Previous requests");
previousRequests.hidden = true;
let requestState: StoredState | undefined;

function renderPreviousRequests() {
  const matches = requestState ? suggestRequests(requestState, input.value) : [];
  previousRequests.replaceChildren(...matches.map((message) => {
    const button = h("button", "", message);
    button.type = "button";
    button.addEventListener("click", () => {
      void openRequestHistory(message);
    });
    const remove = h("button", "delete-request", "", [icon("trash")]);
    remove.type = "button";
    remove.title = "Delete saved request";
    remove.setAttribute("aria-label", `Delete saved request: ${message}`);
    remove.addEventListener("click", async () => {
      input.focus();
      try {
        await deleteRequest(message);
        await refreshRequestState();
      } catch {
        showAlert("Could not delete the saved request.");
      }
    });
    return h("div", "previous-request", "", [button, remove]);
  }));
  previousRequests.hidden = !inspector.hidden || !matches.length;
}

async function refreshRequestState() {
  requestState = await load();
  renderPreviousRequests();
}

input.addEventListener("input", renderPreviousRequests);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.submittedRequests || changes.history)) void refreshRequestState();
});
void refreshRequestState();
const readButton = h("button", "", "Read page aloud");
readButton.type = "button";
const stopButton = h("button", "", "Stop");
stopButton.type = "button";
stopButton.hidden = true;
readButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) void chrome.tabs.sendMessage(tab.id, { kind: "readAloud" } satisfies ContentRequest).catch(() => undefined);
});
stopButton.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "tts-stop" } satisfies TtsRequest).catch(() => undefined));
chrome.runtime.onMessage.addListener((message: unknown) => {
  const state = message as Partial<TtsStateMessage>;
  if (state?.type === "tts-state") {
    stopButton.hidden = !state.speaking;
    readButton.hidden = !!state.speaking;
  }
  return false;
});

const playbackControls = h("div", "tts", "", [readButton, stopButton]);

document.body.append(
  h("main", "", "", [
    h("div", "head", "", [h("div", "head-title", "", [cappyLogo(), h("h1", "", "Debug")]), h("div", "head-actions", "", [backButton, inspectButton])]),
    statusLine,
    usage,
    inspector,
    playbackControls,
    alertText,
    timeline,
    tools,
    form,
    previousRequests,
    live,
  ]),
);

let voiceBase = "";
const voice = new VoiceController({
  onCountdown(ms) {
    paintCountdown(mic, ms);
  },
  onState(state: VoiceState) {
    paintMic(mic, state);
    const text = voiceStatusText(state);
    if (state.phase === "error") {
      live.textContent = "";
      showAlert(text);
    } else {
      live.textContent = text;
      showAlert("");
    }
  },
  onInterim(text) {
    input.value = joinVoiceText(voiceBase, text);
    renderPreviousRequests();
  },
  async onFinal(text) {
    input.value = joinVoiceText(voiceBase, text);
    voiceBase = "";
    const { voiceAutoSend } = await load();
    if (text && voiceAutoSend) form.requestSubmit();
    else {
      renderPreviousRequests();
      input.focus();
    }
  },
});
mic.addEventListener("click", () => {
  if (voice.active) voice.stop();
  else {
    voiceBase = input.value;
    void voice.start();
  }
});
chrome.runtime.onMessage.addListener((message: { kind?: string; event?: unknown }) => {
  if (message?.kind !== "voiceEvent") return;
  const event = parseVoiceEvent(message.event);
  if (event) voice.receive(event);
});

let historyCard: HTMLElement | undefined;
let historyThread: string | undefined;

async function openRequestHistory(message: string) {
  const sessions = findRequestSessions(await load(), message);
  historyThread = message;
  input.value = "";
  input.placeholder = "Continue this session";
  const home = h("button", "", "New chat");
  home.addEventListener("click", () => {
    historyThread = undefined;
    historyCard?.remove();
    input.placeholder = "Ask Cappy";
    input.focus();
  });
  const retry = h("button", "", "Use request again");
  retry.type = "button";
  retry.addEventListener("click", () => {
    input.value = message;
    input.focus();
    renderPreviousRequests();
  });
  historyCard?.remove();
  historyCard = h("div", "run", "", [
    h("div", "top", "", [h("span", "msg", message), h("span", "tag", "Request history")]),
    ...sessions.map(({ reply, outcome }) => h("div", outcome === "error" ? "reply bad" : "reply", reply || "Done.")),
    ...(sessions.length ? [] : [h("p", "", "No reply was saved for this request.")]),
    retry, home,
  ]);
  historyCard.tabIndex = -1;
  timeline.prepend(historyCard);
  input.focus();
}

const runs = new Map<string, { card: HTMLElement; steps: HTMLElement; tag: HTMLElement }>();

function setStatus(status: StatusInfo) {
  statusDot.className = `dot ${status.connected ? "on" : "off"}`;
  statusText.textContent = status.connected ? `${status.provider ?? "Cappy"}${status.models ? ` · ${status.models.fast} / ${status.models.frontier}` : ""}` : (status.error ?? "Server offline");
}

function ensureRun(event: Extract<UiEvent, { runId: string }>, message = "") {
  let run = runs.get(event.runId);
  if (!run) {
    const tag = h("span", "tag", "");
    const steps = h("ul", "steps");
    const card = h("div", "run", "", [h("div", "top", "", [h("span", "msg", message || "Run"), tag]), steps]);
    timeline.prepend(card);
    run = { card, steps, tag };
    runs.set(event.runId, run);
  }
  return run;
}

function onEvent(event: UiEvent) {
  const run = ensureRun(event, event.type === "start" ? (event.message || "Page-load check") : "");
  switch (event.type) {
    case "start":
      run.tag.textContent = event.trigger === "chat" ? "chat" : "page load";
      break;
    case "tier":
      run.tag.className = `tag ${event.tier}`;
      run.tag.textContent = `${event.tier} · ${event.model}`;
      break;
    case "step":
      run.steps.append(h("li", event.tone, event.text));
      break;
    case "blocked":
      run.steps.append(h("li", "bad", `Blocked: ${event.reason}`));
      break;
    case "options": {
      const item = h("li", "info memory-choice", `${event.question} `);
      for (const option of event.options) {
        const pick = h("button", "", option.label);
        pick.type = "button";
        pick.title = option.request;
        pick.addEventListener("click", () => port.postMessage({ type: "chat", message: option.request, thread: historyThread } satisfies DebugPortRequest));
        const edit = h("button", "", "Edit");
        edit.type = "button";
        edit.setAttribute("aria-label", `Edit option: ${option.label}`);
        edit.addEventListener("click", () => {
          input.value = option.request;
          input.focus();
        });
        item.append(pick, edit);
      }
      run.steps.append(item);
      break;
    }
    case "memory":
      if (event.status === "saved") run.steps.append(h("li", "good", `Remembered: ${event.lines.join("; ")}`));
      else for (const line of event.lines) run.steps.append(memoryChoice(line, event.host, event.scope));
      break;
    case "queued":
      run.tag.textContent = "queued";
      break;
    case "cancelled":
      run.steps.append(h("li", "warn", "Stopped"));
      break;
    case "error":
      run.steps.append(h("li", "bad", `Error: ${event.message}`));
      break;
    case "done":
      if (event.reply) run.card.append(h("div", "reply", event.reply));
      if (event.fromCache) run.steps.append(h("li", "good", "Served from saved request"));
      break;
  }
}

const port = chrome.runtime.connect({ name: "debug" });
port.onMessage.addListener((message: DebugPortMessage) => {
  if (message.type === "inspection") {
    if (message.snapshot) renderInspection(inspector, message.snapshot);
    else inspector.replaceChildren(h("p", "", message.error ?? "Could not inspect this page. Reload the tab and try again."));
  }
  else if (message.type === "status") setStatus(message.status);
  else if (message.type === "event") onEvent(message.event);
  else {
    tools.append(h("div", message.ok ? "" : "bad", "", [h("span", "ms", `${message.ms}ms`), h("span", "", `${message.name} ${message.detail}`.slice(0, 120))]));
    tools.scrollTop = tools.scrollHeight;
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  port.postMessage({ type: "chat", message, thread: historyThread } satisfies DebugPortRequest);
  input.value = "";
  renderPreviousRequests();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && voice.active) {
    event.preventDefault();
    voice.stop();
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
