import type { DebugPortMessage, DebugPortRequest, StatusInfo, UiEvent } from "./messages.js";
import { adoptStyles, h } from "./ui/dom.js";
import { TOKENS } from "./ui/theme.js";

const CSS = `
html, body { margin: 0; height: 100%; background: #121217; }
body { display: flex; flex-direction: column; gap: 10px; padding: 14px; font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); }
h1 { margin: 0; font-size: 15px; letter-spacing: -0.01em; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
.dot.on { background: var(--good); } .dot.off { background: var(--bad); }
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
.tools div { display: flex; gap: 8px; } .tools .bad { color: var(--bad); } .tools .ms { color: var(--faint); min-width: 54px; }
form { display: flex; gap: 8px; }
textarea { flex: 1; resize: none; padding: 10px 12px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); color: var(--text); font: inherit; outline: none; }
textarea:focus { border-color: var(--accent); }
button { padding: 0 16px; border: 0; border-radius: 12px; background: var(--grad); color: #0d0d12; font-weight: 650; cursor: pointer; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
`;

adoptStyles(document, TOKENS + CSS);

const statusDot = h("span", "dot");
const statusText = h("span", "", "Connecting");
const timeline = h("div", "timeline");
const tools = h("div", "tools");
const input = h("textarea");
input.rows = 2;
input.placeholder = "Debug chat: runs on the active tab, always asks the AI fresh";
const form = h("form", "", "", [input, h("button", "", "Send")]);

document.body.append(
  h("div", "head", "", [h("h1", "", "Debug"), h("div", "status", "", [statusDot, statusText])]),
  timeline,
  tools,
  form,
);

const runs = new Map<string, { card: HTMLElement; steps: HTMLElement; tag: HTMLElement }>();

function setStatus(status: StatusInfo) {
  statusDot.className = `dot ${status.connected ? "on" : "off"}`;
  statusText.textContent = status.connected ? `${status.provider ?? "agent"}${status.models ? ` · ${status.models.fast} / ${status.models.frontier}` : ""}` : (status.error ?? "Server offline");
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
  if (message.type === "status") setStatus(message.status);
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
  port.postMessage({ type: "chat", message } satisfies DebugPortRequest);
  input.value = "";
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
