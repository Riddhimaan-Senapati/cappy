import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing, Tier } from "../../../shared/protocol.js";
import { ROUTING_LABELS, type BackgroundRequest, type StatusInfo, type TtsRequest } from "../messages.js";
import { DEFAULTS, forgetStoredChange, load, save, type StoredState } from "../storage.js";
import { isScheduleActive, scheduleStatus } from "../../../shared/validate.js";
import { h } from "./dom.js";
import { createMemoryView } from "./memory.js";
import { createProfilesView } from "./profiles.js";
import { createConfigView } from "./config.js";
import { paintOnce, settle } from "../coalesce.js";

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
  setKey(provider: string, key: string | null, baseURL?: string | null): void;
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
      h("h3", "", "Talking"),
      toggle("Send after speaking", "Off lets you edit first", state.voiceAutoSend, (on) => save({ voiceAutoSend: on })),
      voiceLanguage(state),
      h("div", "s-row", "", [h("div", "grow", "", [h("div", "", "Microphone"), h("small", "", "Chrome asks once")]), enable]),
      h("div", "s-note", "Press Alt+Shift+M on a page, or point at something and say what to change. It sends after a short pause or when you say \"done\"."),
    ],
  );
}

function cameraSection(state: StoredState): Node {
  const camera = state.camera;
  const set = (patch: Partial<StoredState["camera"]>) => save({ camera: { ...camera, ...patch } });
  const rows: Node[] = [toggle("Camera control", "Hands-free with your webcam. Video stays on this computer.", camera.enabled, (on) => set({ enabled: on }))];
  if (camera.enabled) {
    rows.push(
      toggle("Air pointer", "Point to move, pinch to click", camera.pointer, (on) => set({ pointer: on })),
      toggle("Hand scrolling", "Open palm high or low", camera.handScroll, (on) => set({ handScroll: on })),
      toggle("Head scrolling", "Tilt your head", camera.headScroll, (on) => set({ headScroll: on })),
      toggle("Swipe to go back", "Swipe an open palm sideways", camera.swipeNav !== false, (on) => set({ swipeNav: on })),
      toggle("Speak after selecting", "Hold a pinch, talk, let go to send", camera.speakAfterSelect !== false, (on) => set({ speakAfterSelect: on })),
    );
    const options: Array<[number, string]> = [[0, "Off"], [800, "0.8s"], [1200, "1.2s"], [2000, "2s"]];
    const segments = options.map(([value, label]) => {
      const button = h("button", "", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(camera.dwellMs === value));
      button.addEventListener("click", () => set({ dwellMs: value }));
      return button;
    });
    rows.push(h("div", "s-note", "Dwell click: hold the pointer still to click"), h("div", "s-seg s-seg4", "", segments), h("div", "s-note", "Thumbs down cancels. Pause from the camera preview."));
  }
  return h("section", "s-sec", "", [h("h3", "", "Camera"), ...rows]);
}

type Tab = "general" | "memory" | "ai" | "voice" | "camera";
const TABS: Array<[Tab, string]> = [["general", "General"], ["memory", "Memory"], ["ai", "AI"], ["voice", "Voice"], ["camera", "Camera"]];
let currentTab: Tab | null = null;

function tabBar(onPick: (tab: Tab) => void): HTMLElement {
  const bar = h("div", "s-tabs");
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Settings sections");
  const buttons = TABS.map(([id, label]) => {
    const button = h("button", "", label);
    button.type = "button";
    button.id = `s-tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(id === currentTab));
    button.setAttribute("aria-controls", "s-panel");
    button.tabIndex = id === currentTab ? 0 : -1;
    button.addEventListener("click", () => onPick(id));
    return button;
  });
  bar.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    event.stopPropagation();
    const focused = buttons.indexOf(event.target as HTMLButtonElement);
    const index = focused >= 0 ? focused : TABS.findIndex(([id]) => id === currentTab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
    onPick(next);
  });
  bar.append(...buttons);
  return bar;
}

const openMore = new Set<string>();

// Settings re-render on every storage change, so open state lives outside the element.
function more(label: string, children: Node[]): HTMLElement {
  const details = h("details", "s-more");
  details.open = openMore.has(label);
  details.addEventListener("toggle", () => (details.open ? openMore.add(label) : openMore.delete(label)));
  details.append(h("summary", "", label), ...children);
  return details;
}

function statusLine(status: StatusInfo, state: StoredState): HTMLElement {
  const provider = status.providers?.find((candidate) => candidate.id === status.activeProvider);
  const [title, sub] = !status.connected
    ? ["Server offline", "Saved changes still work"]
    : provider
      ? [provider.label, status.models ? `${status.models.fast} · ${status.models.frontier}` : "Ready"]
      : ["No AI set up", "Open the AI tab to connect one"];
  const power = h("button", "s-switch");
  power.type = "button";
  power.setAttribute("role", "switch");
  power.setAttribute("aria-checked", String(!state.paused));
  power.setAttribute("aria-label", "Adaptations on all pages");
  power.title = state.paused ? "Adaptations are off" : "Adaptations are on";
  power.addEventListener("click", () => void save({ paused: !state.paused }));
  const dot = h("span", `s-dot ${!status.connected ? "off" : provider ? "on" : "idle"}`);
  return h("div", "s-status", "", [dot, h("div", "grow", "", [h("b", "", title), h("small", "", sub)]), h("small", "s-power", state.paused ? "Off" : "On"), power]);
}

export function renderSettings(root: HTMLElement, ctx: SettingsContext): () => void {
  root.classList.add("s");
  let draft = "";
  let editingKey: string | null = null;
  let confirming: string | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let keyDraft = "";
  let urlDraft = "";
  let disposed = false;
  let refocusTab = false;

  const providerSection = (status: StatusInfo, state: StoredState): Node[] => {
    if (!status.connected) {
      return [h("section", "s-sec", "", [h("h3", "", "AI provider"), h("div", "s-empty", "", [document.createTextNode("Start the local server to connect an AI: "), h("code", "", "bun run dev")])])];
    }
    const rows = (status.providers ?? []).map((provider) => {
      const active = provider.id === status.activeProvider;
      const sub = provider.ready
        ? provider.models
          ? `${provider.detail ? `${provider.detail} · ` : ""}${provider.models.fast} · ${provider.models.frontier}`
          : "Ready"
        : provider.setup === "signin"
          ? "Use your ChatGPT Plus or Pro plan"
          : provider.setup === "endpoint"
            ? "Paste a base URL and an API key"
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
        const setup = h("button", "s-btn s-small", provider.setup === "signin" ? "Sign in" : editingKey === provider.id ? "Cancel" : provider.setup === "endpoint" ? "Add endpoint" : "Add key");
        setup.type = "button";
        setup.addEventListener("click", () => {
          if (provider.setup === "signin") return ctx.signIn();
          editingKey = editingKey === provider.id ? null : provider.id;
          keyDraft = "";
          urlDraft = "";
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
      const url = provider.setup === "endpoint" ? h("input") : null;
      if (url) {
        url.type = "url";
        url.placeholder = "https://api.example.com/v1";
        url.value = urlDraft;
        url.autocomplete = "off";
        url.setAttribute("aria-label", `${provider.label} base URL`);
        url.addEventListener("input", () => (urlDraft = url.value));
      }
      const form = h("form", url ? "s-add stack" : "s-add", "", [url, input, h("button", "s-btn", "Save")]);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        if (url && !url.value.trim()) return;
        ctx.setKey(provider.id, input.value.trim(), url?.value.trim() || null);
        // Voice falls back to these keys, so a new key needs a fresh audio check.
        if (provider.id === "openai-key" && state.voiceProvider === "openai") void save({ voiceProvider: "chrome", openAIVoiceVerified: false });
        if (provider.id === "gemini" && state.voiceProvider === "gemini") void save({ voiceProvider: "chrome", geminiVoiceVerified: false });
        editingKey = null;
        keyDraft = "";
        if (!state.provider) void save({ provider: provider.id });
      });
      queueMicrotask(() => (url ?? input).focus());
      return h("div", "s-sec", "", [row, form]);
    });
    const notice = status.notice ? [h("div", `s-note${status.notice.level === "error" ? " s-error" : ""}`, status.notice.text)] : [];
    const hint = status.activeProvider ? [] : [h("div", "s-note", "Sign in with ChatGPT or add a key. Keys stay on your computer.")];
    return [h("section", "s-sec", "", [h("h3", "", "AI provider"), ...rows, ...notice, ...hint])];
  };
  let queued = false;
  let speechError = "";
  let voiceCheck = "";
  let checkingVoice = false;
  let pendingVoice: "openai" | "gemini" | undefined;

  const paint = paintOnce(async (current) => {
    const [state, changes, status, voices] = await Promise.all([
      settle(load(), { ...DEFAULTS }, 8_000),
      settle(ctx.listChanges(), [] as ActiveChange[], 8_000),
      settle(ctx.getStatus(), { connected: false, busy: false }, 8_000),
      settle(loadVoices(), [], 8_000),
    ]);
    if (disposed || !current()) return;
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
            ...(change.schedule ? [h("div", "why", scheduleStatus(change.schedule) ?? "")] : []),
            h("div", "why", change.reason),
          ]);
        })
      : [h("div", "s-empty", "No changes on this page yet.")];

    const focusRules = [
      ...state.globalChanges.filter((change) => change.schedule).map((change) => ({ host: null as string | null, change })),
      ...Object.entries(state.siteChanges).flatMap(([host, list]) => list.filter((change) => change.schedule).map((change) => ({ host, change }))),
    ];
    const focusRows = focusRules.length
      ? focusRules.map(({ host, change }) => {
          const remove = h("button", "s-link", "Remove");
          remove.type = "button";
          remove.addEventListener("click", async () => {
            if (changes.some((active) => active.id === change.id)) await ctx.revert(change.id);
            else await forgetStoredChange(host, change.id);
            queue();
          });
          let where = "all sites";
          if (host) {
            try {
              where = new URL(host).host;
            } catch {
              where = host;
            }
          }
          const on = change.schedule != null && isScheduleActive(change.schedule, new Date());
          return h("div", `s-change${on ? " on" : ""}`, "", [
            h("div", "top", "", [h("b", "", change.summary), h("span", "s-tag", where), remove]),
            h("div", "why", scheduleStatus(change.schedule) ?? ""),
          ]);
        })
      : [h("div", "s-empty", "No focus rules yet. Ask to hide clutter during work or study, such as Shorts on weekdays 9 to 5.")];

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

    currentTab ??= status.connected && status.activeProvider ? "general" : "ai";
    const number = (value: number) => value.toLocaleString("en-US");
    const usageRow = h("div", "s-row", "", [
      h("div", "grow", "", [h("div", "", "Usage on this browser"), h("small", "", `${number(state.usage.calls)} calls · ${number(state.usage.inputTokens)} in · ${number(state.usage.outputTokens)} out tokens`)]),
    ]);
    const panels: Record<Tab, () => Node[]> = {
      general: () => [
        profiles(state),
        section(
          "Automatic",
          toggle("Act on page load", "Fix new pages before you ask", state.proactive, set("proactive")),
          toggle("Floating button", "Opens the bar with a click", state.floatingButton, set("floatingButton")),
        ),
        section("Focus rules", ...focusRows),
        section(`On this page${changes.length ? ` · ${changes.length}` : ""}`, ...changeRows),
      ],
      memory: () => [
        memory.render(state, toggle),
        section("Data", toggle("Track events", "Log what happens on each page for the debug panel (latest 100)", state.trackEvents, set("trackEvents")), config()),
      ],
      ai: () => [
        ...providerSection(status, state),
        section("Model", h("div", "s-seg", "", segments), h("div", "s-note", routingNote), ...(status.activeProvider ? [more("Choose models", modelPickers(state, status))] : [])),
        section("Usage", usageRow),
      ],
      voice: () => [
        voiceSection(state),
        section(
          "Reading aloud",
          toggle("Read replies aloud", "Speaks what the agent changed", state.speakReplies, set("speakReplies")),
          voiceRow,
          rateRow,
          h("div", "s-foot", "", [testVoice]),
          ...(speechError ? [h("div", "s-note s-error", speechError)] : []),
        ),
        more("Speech provider", [voiceProviderRow, ...(voiceProvider.value !== "chrome" || pendingVoice ? [voiceKeyField, verify] : []), verificationStatus]),
      ],
      camera: () => [cameraSection(state)],
    };
    const pick = (tab: Tab) => {
      currentTab = tab;
      refocusTab = true;
      queue();
    };
    const panel = h("div", "s-panel", "", panels[currentTab]());
    panel.id = "s-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `s-tab-${currentTab}`);
    const link = (label: string, run: () => void) => {
      const button = h("button", "s-link s-quiet", label);
      button.type = "button";
      button.addEventListener("click", run);
      return button;
    };

    root.replaceChildren(
      statusLine(status, state),
      tabBar(pick),
      panel,
      h("div", "s-links", "", [link("Shortcuts", () => ctx.openShortcuts()), link("Setup guide", () => void chrome.runtime.sendMessage({ kind: "openWelcome" })), link("Debug panel", () => ctx.openDebug())]),
    );
    if (refocusTab) {
      refocusTab = false;
      root.querySelector<HTMLElement>(`#s-tab-${currentTab}`)?.focus();
    }
    if (field) {
      const next = focusLabel
        ? root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${CSS.escape(focusLabel)}"]`)
        : root.querySelector<HTMLInputElement>(".s-add input");
      next?.focus();
      if (selection != null) next?.setSelectionRange(selection, selection);
    }
  }, 15_000);

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
  const config = createConfigView(queue);
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
