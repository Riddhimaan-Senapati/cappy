import type { ActiveChange, Change, PageStats } from "../../shared/adaptation.js";
import type { ApplyOutcome, ClientMessage, RunRequest, ServerMessage, ToolCallMessage, Trigger } from "../../shared/protocol.js";
import type { ContentEvent, ContentRequest, ContentResponse } from "./messages.js";
import { load, save } from "./storage.js";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const ui = {
  status: $("#status"),
  pause: $<HTMLInputElement>("#pause"),
  proactive: $<HTMLInputElement>("#proactive"),
  profile: $("#profile"),
  profileForm: $<HTMLFormElement>("#profile-form"),
  profileInput: $<HTMLInputElement>("#profile-input"),
  changes: $("#changes"),
  log: $("#log"),
  form: $<HTMLFormElement>("#composer"),
  input: $<HTMLTextAreaElement>("#message"),
  send: $<HTMLButtonElement>("#send"),
  suggestions: $("#suggestions"),
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "", children: Node[] = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  element.append(...children);
  return element;
}

let socket: WebSocket | null = null;
let currentRun: { runId: string; tabId: number; windowId: number; trigger: Trigger; steps: HTMLElement; appliedIds: string[]; summaries: string[] } | null = null;
const proactiveDone = new Set<string>();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab<T>(tabId: number, request: ContentRequest): Promise<T> {
  const response: ContentResponse | undefined = await chrome.tabs.sendMessage(tabId, request);
  if (!response) throw new Error("No response from page. Reload the tab after installing the extension.");
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

function connect(url: string) {
  ui.status.textContent = "Connecting…";
  ui.status.dataset.state = "connecting";
  socket = new WebSocket(url);
  socket.onmessage = (event) => onServerMessage(JSON.parse(event.data) as ServerMessage);
  socket.onclose = () => {
    ui.status.textContent = "Server offline · retrying";
    ui.status.dataset.state = "offline";
    if (currentRun) finishRun();
    setTimeout(() => connect(url), 3000);
  };
}

function sendToServer(message: ClientMessage) {
  socket?.send(JSON.stringify(message));
}

async function captureScreenshot(windowId: number): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, 1280 / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

async function runTool(message: ToolCallMessage) {
  if (!currentRun || message.runId !== currentRun.runId) return;
  const run = currentRun;
  try {
    let result: unknown;
    if (message.name === "screenshot") {
      if (run.trigger === "page_load") await sendToTab(run.tabId, { kind: "busy", on: false });
      result = { dataUrl: await captureScreenshot(run.windowId) };
    } else {
      result = await sendToTab(run.tabId, { kind: "tool", name: message.name, input: message.input });
    }
    if (message.name === "apply_change") {
      const change = (message.input as { change: Change }).change;
      const outcome = result as ApplyOutcome;
      if (run.trigger === "page_load") await sendToTab(run.tabId, { kind: "busy", on: false });
      if (outcome.ok) {
        run.appliedIds.push(change.id);
        run.summaries.push(change.summary);
      }
      renderOutcome(run.steps, change, outcome);
    }
    sendToServer({ type: "toolResult", callId: message.callId, ok: true, result });
  } catch (error) {
    sendToServer({ type: "toolResult", callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const STAT_LABELS: Record<keyof PageStats, string> = {
  inputsWithoutLabel: "unlabeled inputs",
  smallTargets: "small targets",
  smallText: "small text",
  lowContrastText: "low-contrast text",
  imagesWithoutAlt: "images without alt",
  runningAnimations: "animations",
  visibleAdsOrPopups: "ads/popups",
};

function renderOutcome(steps: HTMLElement, change: Change, outcome: ApplyOutcome) {
  if (!outcome.ok) {
    steps.append(h("li", "step bad", `Failed: ${outcome.error}`));
    return;
  }
  const deltas = (Object.keys(STAT_LABELS) as Array<keyof PageStats>)
    .filter((key) => outcome.before[key] !== outcome.after[key])
    .map((key) => `${STAT_LABELS[key]} ${outcome.before[key]} → ${outcome.after[key]}`);
  const zero = Object.entries(outcome.matched).filter(([, count]) => count === 0).map(([selector]) => selector);
  if (deltas.length) steps.append(h("li", "step good", `Verified: ${deltas.join(", ")}`));
  if (zero.length) steps.append(h("li", "step warn", `Matched nothing: ${zero.slice(0, 3).join(", ")}`));
}

function onServerMessage(message: ServerMessage) {
  switch (message.type) {
    case "hello":
      ui.status.textContent = `${message.provider} · ${message.model}`;
      ui.status.dataset.state = "online";
      return;
    case "tool":
      void runTool(message);
      return;
  }
  if (!currentRun || message.runId !== currentRun.runId) return;
  switch (message.type) {
    case "progress":
      currentRun.steps.append(h("li", "step", message.text));
      break;
    case "warning":
      currentRun.steps.append(h("li", "step bad", message.text));
      break;
    case "profile":
      void addProfileLines(message.lines);
      currentRun.steps.append(h("li", "step good", `Remembered: ${message.lines.join("; ")}`));
      break;
    case "done":
      void onDone(message.reply);
      break;
    case "error":
      currentRun.steps.append(h("li", "step bad", `Error: ${message.message}`));
      finishRun();
      break;
  }
  scrollLog();
}

async function onDone(reply: string) {
  const run = currentRun!;
  if (reply) {
    addBubble("assistant", reply);
    const state = await load();
    await save({ history: [...state.history, { role: "assistant" as const, text: reply }].slice(-20) });
  }
  if (run.trigger === "page_load" && run.appliedIds.length) {
    await sendToTab(run.tabId, { kind: "toast", text: `Adapted for you: ${run.summaries.join(", ")}.`, undoIds: run.appliedIds }).catch(() => undefined);
  }
  if (run.trigger === "page_load" && !run.appliedIds.length && !reply) run.steps.closest(".bubble")?.remove();
  finishRun();
}

function finishRun() {
  if (currentRun?.trigger === "page_load") void sendToTab(currentRun.tabId, { kind: "busy", on: false }).catch(() => undefined);
  currentRun?.steps.classList.add("done");
  currentRun = null;
  ui.send.disabled = false;
  void renderChanges();
}

function addBubble(role: "user" | "assistant" | "system", text: string) {
  const bubble = h("div", `bubble ${role}`, "", [h("p", "", text)]);
  ui.log.append(bubble);
  scrollLog();
  return bubble;
}

function scrollLog() {
  ui.log.scrollTop = ui.log.scrollHeight;
}

async function startRun(trigger: Trigger, message: string) {
  if (currentRun || socket?.readyState !== WebSocket.OPEN) return false;
  const tab = await activeTab();
  if (!tab?.id || !tab.url?.startsWith("http")) {
    addBubble("system", "Open a regular web page to adapt it.");
    return false;
  }
  const state = await load();
  if (state.paused) {
    addBubble("system", "Adaptations are paused. Turn them back on first.");
    return false;
  }

  let active: ActiveChange[] = [];
  try {
    active = await sendToTab<ActiveChange[]>(tab.id, { kind: "list" });
  } catch (error) {
    addBubble("system", error instanceof Error ? error.message : String(error));
    return false;
  }

  if (trigger === "chat") {
    addBubble("user", message);
    await save({ history: [...state.history, { role: "user" as const, text: message }].slice(-20) });
  }

  const steps = h("ul", "steps");
  ui.log.append(h("div", "bubble agent", "", [h("p", "label", trigger === "page_load" ? "Checking this page for you" : "Working on it"), steps]));
  currentRun = { runId: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, trigger, steps, appliedIds: [], summaries: [] };
  ui.send.disabled = true;
  if (trigger === "page_load") await sendToTab(tab.id, { kind: "busy", on: true }).catch(() => undefined);

  const request: RunRequest = {
    type: "run",
    runId: currentRun.runId,
    trigger,
    message,
    history: state.history.slice(-8),
    profile: state.profile,
    active,
  };
  sendToServer(request);
  scrollLog();
  return true;
}

async function addProfileLines(lines: string[]) {
  const state = await load();
  await save({ profile: [...state.profile, ...lines.filter((line) => !state.profile.includes(line))] });
  await renderProfile();
}

async function renderProfile() {
  const { profile } = await load();
  ui.profile.replaceChildren(
    ...(profile.length
      ? profile.map((line, index) => {
          const remove = h("button", "icon", "✕");
          remove.setAttribute("aria-label", `Remove "${line}"`);
          remove.addEventListener("click", async () => {
            const state = await load();
            await save({ profile: state.profile.filter((_, i) => i !== index) });
            await renderProfile();
          });
          return h("li", "", "", [h("span", "", line), remove]);
        })
      : [h("li", "empty", "Tell me about your needs in the chat, or add a line below.")]),
  );
}

async function renderChanges() {
  const tab = await activeTab();
  let active: ActiveChange[] = [];
  if (tab?.id) active = await sendToTab<ActiveChange[]>(tab.id, { kind: "list" }).catch(() => []);
  ui.changes.replaceChildren(
    ...(active.length
      ? active.map((change) => {
          const undo = h("button", "link", "Undo");
          undo.addEventListener("click", async () => {
            await sendToTab(tab!.id!, { kind: "tool", name: "revert_change", input: { id: change.id } });
            await renderChanges();
          });
          return h("li", "change", "", [
            h("div", "change-head", "", [h("strong", "", change.summary), h("span", `scope ${change.scope}`, change.scope === "everywhere" ? "all sites" : "this site"), undo]),
            h("p", "reason", change.reason),
          ]);
        })
      : [h("li", "empty", "No changes on this page yet.")]),
  );
}

ui.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = ui.input.value.trim();
  if (!text) return;
  if (await startRun("chat", text)) ui.input.value = "";
});

ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    ui.form.requestSubmit();
  }
});

ui.suggestions.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) return;
  ui.input.value = button.textContent ?? "";
  ui.form.requestSubmit();
});

ui.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const line = ui.profileInput.value.trim();
  if (!line) return;
  await addProfileLines([line]);
  ui.profileInput.value = "";
});

ui.pause.addEventListener("change", async () => {
  const paused = !ui.pause.checked;
  await save({ paused });
  const tab = await activeTab();
  if (tab?.id) await sendToTab(tab.id, { kind: "pause", paused }).catch(() => undefined);
  await renderChanges();
});

ui.proactive.addEventListener("change", () => save({ proactive: ui.proactive.checked }));

chrome.runtime.onMessage.addListener((event: ContentEvent, sender) => {
  void (async () => {
    const tab = await activeTab();
    if (sender.tab?.id !== tab?.id) return;
    await renderChanges();
    if (event.kind !== "pageReady") return;
    const state = await load();
    if (!state.proactive || state.paused || !state.profile.length || event.restored > 0 || proactiveDone.has(event.origin)) return;
    proactiveDone.add(event.origin);
    await startRun("page_load", "");
  })();
});

chrome.tabs.onActivated.addListener(() => void renderChanges());

(async () => {
  const state = await load();
  ui.pause.checked = !state.paused;
  ui.proactive.checked = state.proactive;
  for (const turn of state.history.slice(-6)) addBubble(turn.role, turn.text);
  await renderProfile();
  await renderChanges();
  connect(state.serverUrl);
})();
