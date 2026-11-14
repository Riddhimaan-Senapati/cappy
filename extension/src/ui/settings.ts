import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing, Tier } from "../../../shared/protocol.js";
import { ROUTING_LABELS, type BackgroundRequest, type StatusInfo, type TtsRequest } from "../messages.js";
import { load, save, type StoredState } from "../storage.js";
import { h, icon } from "./dom.js";
import { createMemoryView } from "./memory.js";

let voicesRequest: Promise<string[]> | null = null;

function loadVoices(): Promise<string[]> {
  voicesRequest ??= chrome.runtime
    .sendMessage({ type: "tts-voices" } satisfies TtsRequest)
    .then((response: { voices?: Array<{ voiceName: string }> } | undefined) => {
      const names = (response?.voices ?? []).map((voice) => voice.voiceName);
      if (!names.length) voicesRequest = null;
      return names;
    })
    .catch(() => []);
  return voicesRequest;
}

export interface SettingsContext {
  listChanges(): Promise<ActiveChange[]>;
  revert(id: string): Promise<void>;
  openDebug(): void;
  openShortcuts(): void;
  getStatus(): Promise<StatusInfo>;
}

function toggle(label: string, sub: string, checked: boolean, onChange: (value: boolean) => void) {
  const button = h("button", "s-switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(checked));
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => onChange(!checked));
  return h("div", "s-row", "", [h("div", "grow", "", [h("div", "", label), h("small", "", sub)]), button]);
}

function modelPickers(state: StoredState, status: StatusInfo): Node[] {
  const defaults = status.models;
  const available = status.available ?? [];
  const field = (tier: Tier, label: string) => {
    const current = state.modelOverrides[tier] ?? "";
    const options = [...new Set([current, ...available].filter(Boolean))];
    const select = h("select", "s-select");
    select.setAttribute("aria-label", `${label} model`);
    select.append(h("option", "", `Default${defaults ? ` (${defaults[tier]})` : ""}`));
    select.firstElementChild!.setAttribute("value", "");
    for (const id of options) {
      const option = h("option", "", id);
      option.value = id;
      select.append(option);
    }
    select.value = current;
    select.addEventListener("change", () => {
      const next = { ...state.modelOverrides };
      if (select.value) next[tier] = select.value;
      else delete next[tier];
      void save({ modelOverrides: next });
    });
    return h("label", "s-row", "", [h("div", "grow", "", [h("div", "", label), h("small", "", tier === "fast" ? "Used for simple requests and page-load checks" : "Used for harder requests and retries")]), select]);
  };
  return [field("fast", "Fast model"), field("frontier", "Frontier model")];
}

const VOICE_LANGUAGES = ["en-US", "en-GB", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "nl-NL", "hi-IN", "ja-JP", "ko-KR", "zh-CN"];

function voiceLanguage(state: StoredState): Node {
  const select = h("select", "s-select");
  select.setAttribute("aria-label", "Speech language");
  const browser = h("option", "", `Browser (${navigator.language})`);
  browser.value = "";
  select.append(browser);
  const options = [...new Set([state.voiceLang, ...VOICE_LANGUAGES].filter(Boolean))];
  for (const lang of options) {
    const option = h("option", "", lang);
    option.value = lang;
    select.append(option);
  }
  select.value = state.voiceLang;
  select.addEventListener("change", () => void save({ voiceLang: select.value }));
  return h("label", "s-row", "", [h("div", "grow", "", [h("div", "", "Language"), h("small", "", "The language you speak in")]), select]);
}

function voiceSection(state: StoredState): Node {
  const enable = h("button", "s-btn", "Enable microphone");
  enable.type = "button";
  enable.addEventListener("click", () => void chrome.runtime.sendMessage({ kind: "voiceOpenMic" } satisfies BackgroundRequest).catch(() => undefined));
  return h(
    "section",
    "s-sec",
    "",
    [
      h("h3", "", "Voice"),
      toggle("Send after speaking", "Off leaves your words in the box to edit first.", state.voiceAutoSend, (on) => save({ voiceAutoSend: on })),
      voiceLanguage(state),
      h("div", "s-row", "", [h("div", "grow", "", [h("div", "", "Microphone"), h("small", "", "Chrome asks once. Allow it in the tab that opens.")]), enable]),
      h("div", "s-note", "Speech is processed by Chrome. Press the mic button or Alt+M in the bar to speak."),
    ],
  );
}

function statusCard(status: StatusInfo) {
  const dot = h("span", `s-dot ${status.connected ? "on" : "off"}`);
  const title = status.connected ? `Connected to ${status.provider ?? "agent"}` : "Agent server offline";
  const sub = status.connected && status.models ? `${status.models.fast} (fast) · ${status.models.frontier} (frontier)` : (status.error ?? "Start it with npm run dev");
  return h("div", "s-status", "", [dot, h("div", "", "", [h("b", "", title), h("small", "", sub)])]);
}

export function renderSettings(root: HTMLElement, ctx: SettingsContext): () => void {
  root.classList.add("s");
  let disposed = false;
  let queued = false;

  const paint = async () => {
    const [state, changes, status, voices] = await Promise.all([load(), ctx.listChanges().catch(() => []), ctx.getStatus().catch(() => ({ connected: false, busy: false })), loadVoices()]);
    if (disposed) return;
    const focused = root.getRootNode() instanceof ShadowRoot ? (root.getRootNode() as ShadowRoot).activeElement : document.activeElement;
    const hadFocus = focused instanceof HTMLInputElement && root.contains(focused);

    const segments = (["auto", "fast", "frontier"] as Routing[]).map((value) => {
      const button = h("button", "", ROUTING_LABELS[value]);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.routing === value));
      button.addEventListener("click", () => save({ routing: value }));
      return button;
    });
    const routingNote =
      state.routing === "auto"
        ? "Simple requests use the fast model. Harder ones, or ones that fail, use the frontier model."
        : state.routing === "fast"
          ? "Always the fast model. Quickest, may miss on hard pages."
          : "Always the frontier model. Most capable, slower.";

    const changeRows = changes.length
      ? changes.map((change) => {
          const undo = h("button", "s-link", "Undo");
          undo.type = "button";
          undo.addEventListener("click", async () => {
            await ctx.revert(change.id);
            queue();
          });
          return h("div", "s-change", "", [
            h("div", "top", "", [h("b", "", change.summary), h("span", "s-tag", change.scope === "everywhere" ? "all sites" : "this site"), undo]),
            h("div", "why", change.reason),
          ]);
        })
      : [h("div", "s-empty", "No changes on this page yet.")];

    const shortcuts = h("button", "s-btn", "", [icon("keyboard", 15), document.createTextNode("Shortcuts")]);
    shortcuts.type = "button";
    shortcuts.addEventListener("click", () => ctx.openShortcuts());
    const debug = h("button", "s-btn", "", [icon("bug", 15), document.createTextNode("Debug panel")]);
    debug.type = "button";
    debug.addEventListener("click", () => ctx.openDebug());

    const section = (title: string, ...children: Node[]) => h("section", "s-sec", "", [h("h3", "", title), ...children]);
    const set = <K extends keyof StoredState>(key: K) => (value: StoredState[K]) => save({ [key]: value } as Partial<StoredState>);

    const voiceSelect = h("select", "s-select");
    voiceSelect.setAttribute("aria-label", "Voice");
    const defaultVoice = h("option", "", "Default voice");
    defaultVoice.value = "";
    voiceSelect.append(defaultVoice);
    for (const name of new Set([state.ttsVoice, ...voices].filter(Boolean))) {
      const option = h("option", "", name);
      option.value = name;
      voiceSelect.append(option);
    }
    voiceSelect.value = state.ttsVoice;
    voiceSelect.addEventListener("change", () => void save({ ttsVoice: voiceSelect.value }));
    const voiceRow = h("label", "s-row", "", [
      h("div", "grow", "", [h("div", "", "Voice"), h("small", "", voices.length ? "Voices installed on this device" : "No voices found yet")]),
      voiceSelect,
    ]);

    const rate = h("input");
    rate.type = "range";
    rate.min = "0.5";
    rate.max = "2";
    rate.step = "0.1";
    rate.value = String(state.ttsRate);
    rate.setAttribute("aria-label", "Speaking rate");
    const rateValue = h("small", "", `${state.ttsRate.toFixed(1)}×`);
    rate.addEventListener("input", () => (rateValue.textContent = `${Number(rate.value).toFixed(1)}×`));
    rate.addEventListener("change", () => void save({ ttsRate: Number(rate.value) }));
    const rateRow = h("label", "s-row", "", [h("div", "grow", "", [h("div", "", "Speed"), rateValue]), rate]);

    const testVoice = h("button", "s-btn", "Test voice");
    testVoice.type = "button";
    testVoice.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "tts-speak", text: "This is how I sound.", source: "test" } satisfies TtsRequest).catch(() => undefined));

    root.replaceChildren(
      statusCard(status),
      section(
        "General",
        toggle("Adaptations", "Master switch. Off reverts everything.", !state.paused, (on) => set("paused")(!on)),
        toggle("Act on page load", "Fix pages for you before you ask.", state.proactive, set("proactive")),
        toggle("Floating button", "A small button that opens the bar.", state.floatingButton, set("floatingButton")),
      ),
      section("Model", h("div", "s-seg", "", segments), h("div", "s-note", routingNote), ...modelPickers(state, status)),
      memory.render(state, toggle),
      section(
        "Speech",
        toggle("Read replies aloud", "Speaks chat replies and page-load announcements.", state.speakReplies, set("speakReplies")),
        voiceRow,
        rateRow,
        h("div", "s-foot", "", [testVoice]),
      ),
      voiceSection(state),
      section("On this page", ...changeRows),
      h("div", "s-foot", "", [shortcuts, debug]),
    );
    if (hadFocus) root.querySelector<HTMLInputElement>(".s-add input")?.focus();
  };

  const queue = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void paint();
    });
  };

  const memory = createMemoryView(queue);
  const onStorage = () => queue();
  chrome.storage.onChanged.addListener(onStorage);
  void paint();
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
