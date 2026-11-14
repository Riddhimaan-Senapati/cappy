import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing, Tier } from "../../../shared/protocol.js";
import { ROUTING_LABELS, type BackgroundRequest, type StatusInfo, type TtsRequest } from "../messages.js";
import { load, save, type StoredState } from "../storage.js";
import { usageCard, USAGE_CSS } from "./usage.js";
import { adoptStyles, h, icon } from "./dom.js";
import { createMemoryView } from "./memory.js";
import { createProfilesView } from "./profiles.js";

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
  setKey(provider: string, key: string | null): void;
  signIn(): void;
  signOut(): void;
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
  if (!status.activeProvider) return [];
  const defaults = status.models;
  const available = status.available ?? [];
  const field = (tier: Tier, label: string) => {
    const providerId = status.activeProvider ?? "";
    const current = state.modelChoices[providerId]?.[tier] ?? "";
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
      const next = { ...(state.modelChoices[providerId] ?? {}) };
      if (select.value) next[tier] = select.value;
      else delete next[tier];
      void save({ modelChoices: { ...state.modelChoices, [providerId]: next } });
    });
    return h("label", "s-row", "", [h("div", "grow", "", [h("div", "", label), h("small", "", tier === "fast" ? "Used for simple requests and page-load checks" : "Used for harder requests and retries")]), select]);
  };
  return [field("fast", "Fast model"), field("frontier", "Pro model")];
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
      h("div", "s-note", "Press Alt+Shift+M (Option+Shift+M on Mac) on a page to speak. With the bar closed, point at something with the mouse or the camera pointer and say what to change, like \"make this red\". It sends after a short pause (a ring shows it is about to), when you say \"done\", or after 15 seconds. Keep talking to cancel the pause. Change the shortcut under Shortcuts."),
    ],
  );
}

function cameraSection(state: StoredState): Node {
  const camera = state.camera;
  const set = (patch: Partial<StoredState["camera"]>) => save({ camera: { ...camera, ...patch } });
  const rows: Node[] = [toggle("Camera control", "Hands-free control with your webcam. Video stays on this computer.", camera.enabled, (on) => set({ enabled: on }))];
  if (camera.enabled) {
    rows.push(
      toggle("Air pointer", "Point to move, pinch thumb and finger to click.", camera.pointer, (on) => set({ pointer: on })),
      toggle("Hand scrolling", "Open palm high to scroll up, low to scroll down.", camera.handScroll, (on) => set({ handScroll: on })),
      toggle("Head scrolling", "Tilt your head down or up to scroll.", camera.headScroll, (on) => set({ headScroll: on })),
      toggle("Swipe to go back", "Swipe an open palm sideways for back or forward.", camera.swipeNav !== false, (on) => set({ swipeNav: on })),
      toggle("Speak after selecting", "Pinch and hold on something and keep holding while you say what to change, like \"make this red\". Let go to send.", camera.speakAfterSelect !== false, (on) => set({ speakAfterSelect: on })),
    );
    const options: Array<[number, string]> = [[0, "Off"], [800, "0.8s"], [1200, "1.2s"], [2000, "2s"]];
    const segments = options.map(([value, label]) => {
      const button = h("button", "", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(camera.dwellMs === value));
      button.addEventListener("click", () => set({ dwellMs: value }));
      return button;
    });
    rows.push(h("div", "s-note", "Dwell click: hold the pointer still to click, for when pinching is hard."), h("div", "s-seg s-seg4", "", segments), h("div", "s-note", "Thumbs down to cancel. Pause from the camera preview: point at Pause and pinch."));
  }
  return h("section", "s-sec", "", [h("h3", "", "Camera"), ...rows]);
}

function statusCard(status: StatusInfo) {
  const dot = h("span", `s-dot ${status.connected ? "on" : "off"}`);
  const title = status.connected ? `Connected to ${status.provider ?? "agent"}` : "Offline mode";
  const sub = status.connected && status.models ? `${status.models.fast} (Fast) · ${status.models.frontier} (Pro)` : status.connected ? "Sign in with ChatGPT or add an API key below." : "Saved adaptations, request suggestions, and widget controls are available. New AI requests need the local server.";
  return h("div", "s-status", "", [dot, h("div", "", "", [h("b", "", title), h("small", "", sub)])]);
}

export function renderSettings(root: HTMLElement, ctx: SettingsContext): () => void {
  root.classList.add("s");
  adoptStyles(root.getRootNode() as Document | ShadowRoot, USAGE_CSS);
  let draft = "";
  let editingKey: string | null = null;
  let confirming: string | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let keyDraft = "";
  let disposed = false;

  const providerSection = (status: StatusInfo, state: StoredState): Node[] => {
    if (!status.connected) return [statusCard(status)];
    const rows = (status.providers ?? []).map((provider) => {
      const active = provider.id === status.activeProvider;
      const sub = provider.ready
        ? provider.models
          ? `${provider.models.fast} · ${provider.models.frontier}`
          : "Ready"
        : provider.setup === "signin"
          ? "Use your ChatGPT Plus or Pro plan"
          : "Paste an API key to use it";
      let action: Node;
      if (provider.ready) {
        const isSignin = provider.setup === "signin";
        const armed = confirming === provider.id;
        const disconnect = h("button", `s-link${armed ? " s-danger" : " s-quiet"}`, armed ? (isSignin ? "Confirm sign out" : "Confirm remove") : isSignin ? "Sign out" : "Remove key");
        disconnect.type = "button";
        disconnect.setAttribute("aria-label", armed ? `Confirm: disconnect ${provider.label}` : `Disconnect ${provider.label}`);
        disconnect.addEventListener("click", () => {
          clearTimeout(confirmTimer);
          if (!armed) {
            confirming = provider.id;
            confirmTimer = setTimeout(() => {
              confirming = null;
              queue();
            }, 4000);
            return queue();
          }
          confirming = null;
          if (isSignin) ctx.signOut();
          else ctx.setKey(provider.id, null);
          if (state.provider === provider.id) void save({ provider: null });
        });
        let primary: Node;
        if (active) primary = h("span", "s-on", "In use");
        else {
          const use = h("button", "s-btn s-small", "Use");
          use.type = "button";
          use.addEventListener("click", () => save({ provider: provider.id }));
          primary = use;
        }
        action = h("div", "s-acts", "", [disconnect, primary]);
      } else {
        const setup = h("button", "s-btn s-small", provider.setup === "signin" ? "Sign in" : editingKey === provider.id ? "Cancel" : "Add key");
        setup.type = "button";
        setup.addEventListener("click", () => {
          if (provider.setup === "signin") return ctx.signIn();
          editingKey = editingKey === provider.id ? null : provider.id;
          keyDraft = "";
          queue();
        });
        action = setup;
      }
      const row = h("div", `s-row${active ? " s-active" : ""}`, "", [h("span", `s-dot ${provider.ready ? "on" : "idle"}`), h("div", "grow", "", [h("div", "", provider.label), h("small", "", sub)]), action]);
      if (editingKey !== provider.id) return row;

      const input = h("input");
      input.type = "password";
      input.placeholder = `${provider.label} API key`;
      input.value = keyDraft;
      input.autocomplete = "off";
      input.setAttribute("aria-label", `${provider.label} API key`);
      input.addEventListener("input", () => (keyDraft = input.value));
      const form = h("form", "s-add", "", [input, h("button", "s-btn", "Save")]);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        ctx.setKey(provider.id, input.value.trim());
        // Voice falls back to these keys, so a new key needs a fresh audio check.
        if (provider.id === "openai-key" && state.voiceProvider === "openai") void save({ voiceProvider: "chrome", openAIVoiceVerified: false });
        if (provider.id === "gemini" && state.voiceProvider === "gemini") void save({ voiceProvider: "chrome", geminiVoiceVerified: false });
        editingKey = null;
        keyDraft = "";
        if (!state.provider) void save({ provider: provider.id });
      });
      queueMicrotask(() => input.focus());
      return h("div", "s-sec", "", [row, form]);
    });
    const notice = status.notice ? [h("div", `s-note${status.notice.level === "error" ? " s-error" : ""}`, status.notice.text)] : [];
    const hint = status.activeProvider ? [] : [h("div", "s-note", "Sign in with ChatGPT or add a key to start. Keys stay on your computer, in the local server.")];
    return [h("section", "s-sec", "", [h("h3", "", "AI provider"), ...rows, ...notice, ...hint])];
  };
  let queued = false;
  let speechError = "";
  let voiceCheck = "";
  let checkingVoice = false;
  let pendingVoice: "openai" | "gemini" | undefined;

  const paint = async () => {
    const [state, changes, status, voices] = await Promise.all([load(), ctx.listChanges().catch(() => []), ctx.getStatus().catch(() => ({ connected: false, busy: false })), loadVoices()]);
    if (disposed) return;
    const focused = root.getRootNode() instanceof ShadowRoot ? (root.getRootNode() as ShadowRoot).activeElement : document.activeElement;
    const field = (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && root.contains(focused) ? focused : null;
    const focusLabel = field?.getAttribute("aria-label");
    const selection = field?.selectionStart;

    const segments = (["auto", "fast", "frontier"] as Routing[]).map((value) => {
      const button = h("button", "", ROUTING_LABELS[value]);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.routing === value));
      button.addEventListener("click", () => save({ routing: value }));
      return button;
    });
    const routingNote =
      state.routing === "auto"
        ? "Picks per request: Fast for simple ones, Pro for harder ones or when Fast misses."
        : state.routing === "fast"
          ? "Quickest. Press Tab in the bar to use Pro for a harder request."
          : "Most capable, slower. Press Tab in the bar to go back to Fast.";

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
    const guide = h("button", "s-btn", "", [icon("sparkle", 15), document.createTextNode("Setup guide")]);
    guide.type = "button";
    guide.addEventListener("click", () => void chrome.runtime.sendMessage({ kind: "openWelcome" }));

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

    const voiceProvider = h("select", "s-select");
    voiceProvider.setAttribute("aria-label", "Voice provider");
    for (const [id, label] of [["chrome", "Chrome"], ["openai", "OpenAI"], ["gemini", "Gemini"]]) {
      const option = h("option", "", label);
      option.value = id;
      voiceProvider.append(option);
    }
    const activeVoice = state.voiceProvider;
    voiceProvider.value = activeVoice;
    const provider = pendingVoice ?? (activeVoice === "gemini" ? "gemini" : "openai");
    const label = provider === "gemini" ? "Gemini" : "OpenAI";
    voiceProvider.disabled = checkingVoice;
    voiceProvider.addEventListener("change", () => {
      if (voiceProvider.value === "chrome") {
        pendingVoice = undefined;
        voiceCheck = "";
        void save({ voiceProvider: "chrome" });
      } else if (voiceProvider.value === "gemini" || voiceProvider.value === "openai") {
        pendingVoice = voiceProvider.value;
        voiceCheck = "";
        queue();
      }
    });
    const voiceKey = h("input");
    voiceKey.type = "password";
    voiceKey.autocomplete = "off";
    voiceKey.placeholder = `${label} API key`;
    voiceKey.setAttribute("aria-label", `${label} voice API key`);
    voiceKey.disabled = checkingVoice;
    const keyHelp = h("small", "", `Add a ${label} API key to enable its audio models. Leave blank to use a saved key.`);
    const voiceKeyField = h("label", "s-row", "", [h("div", "grow", "", [h("div", "", `Add a ${label} API key`), keyHelp]), voiceKey]);
    const verify = h("button", "s-btn", `Verify and enable ${label}`);
    verify.type = "button";
    verify.disabled = checkingVoice;
    verify.addEventListener("click", async () => {
      if (checkingVoice) return;
      const key = voiceKey.value.trim();
      voiceKey.value = "";
      checkingVoice = true;
      voiceCheck = "Checking speech and transcription with a short sample…";
      queue();
      try {
        const result = await chrome.runtime.sendMessage({ kind: "verifyVoice", key, provider } satisfies BackgroundRequest);
        if (!result?.ok) throw new Error(result?.error ?? "Could not verify OpenAI audio.");
        await save(provider === "openai" ? { voiceProvider: provider, openAIVoiceVerified: true } : { voiceProvider: provider, geminiVoiceVerified: true });
        pendingVoice = undefined;
        voiceCheck = `${label} audio verified.`;
      } catch (error) {
        voiceCheck = error instanceof Error ? error.message : "Could not verify OpenAI audio.";
      } finally {
        checkingVoice = false;
        queue();
      }
    });
    const voiceProviderRow = h("label", "s-row", "", [
      h("div", "grow", "", [h("div", "", "Voice provider"), h("small", "", "OpenAI and Gemini process recorded audio and spoken text through their APIs. Verification uses a short sample and may incur API usage.")]),
      voiceProvider,
    ]);
    const verificationStatus = h("div", "s-note", voiceCheck);
    verificationStatus.setAttribute("role", "status");

    root.replaceChildren(
      profiles(state),
      usageCard(state.usage),
      ...providerSection(status, state),
      section(
        "General",
        toggle("Adaptations", "Master switch. Off reverts everything.", !state.paused, (on) => set("paused")(!on)),
        toggle("Act on page load", "Fix pages for you before you ask.", state.proactive, set("proactive")),
        toggle("Floating button", "A small button that opens the bar.", state.floatingButton, set("floatingButton")),
      ),
      section("Model", h("div", "s-seg", "", segments), h("div", "s-note", routingNote), ...modelPickers(state, status), voiceProviderRow, voiceKeyField, verify, verificationStatus),
      memory.render(state, toggle),
      section(
        "Speech",
        toggle("Read replies aloud", "Speaks chat replies and page-load announcements.", state.speakReplies, set("speakReplies")),
        voiceRow,
        rateRow,
        h("div", "s-foot", "", [testVoice]),
        h("div", "s-note", speechError),
      ),
      voiceSection(state),
      cameraSection(state),
      section("On this page", ...changeRows),
      h("div", "s-foot", "", [shortcuts, debug, guide]),
    );
    if (field) {
      const next = focusLabel
        ? root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${CSS.escape(focusLabel)}"]`)
        : root.querySelector<HTMLInputElement>(".s-add input");
      next?.focus();
      if (selection != null) next?.setSelectionRange(selection, selection);
    }
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
  const profiles = createProfilesView(queue);
  const onStorage = () => queue();
  chrome.storage.onChanged.addListener(onStorage);
  const onSpeechError = (message: { type?: string; message?: string }) => {
    if (message.type !== "tts-error") return;
    speechError = message.message ?? "";
    queue();
  };
  chrome.runtime.onMessage.addListener(onSpeechError);
  void paint();
  return () => {
    disposed = true;
    chrome.runtime.onMessage.removeListener(onSpeechError);
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
