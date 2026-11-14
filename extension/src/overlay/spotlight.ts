import { reportExtensionError } from "../extension-context.js";
import type { ActiveChange } from "../../../shared/adaptation.js";
import type { MemoryScope, OptionChoice, Routing, Suggestion } from "../../../shared/protocol.js";
import { ROUTING_LABELS, type AppliedSummary, type StatusInfo, type UiEvent } from "../messages.js";
import { forgetLine } from "../memory.js";
import { outcomeText, scopeChoices } from "../ui/memory-choice.js";
import { deleteRequest, findRequestSessions, load, save, suggestRequests, type SavedCommand, type StoredState } from "../storage.js";
import { h, icon, type IconName } from "../ui/dom.js";
import { renderSettings, type SettingsContext } from "../ui/settings.js";
import { paintMic, liveRegion, micButton } from "../voice/button.js";
import { VoiceController } from "../voice/controller.js";
import { joinVoiceText, voiceStatusText, type VoiceEvent, type VoiceState } from "../voice/core.js";

export interface SpotlightDeps {
  ask(message: string, fresh: boolean, interrupt?: boolean, thread?: string): void;
  stop(): void;
  dequeue(runId: string): void;
  listChanges(): ActiveChange[];
  history(): Array<{ change: ActiveChange; active: boolean }>;
  reapply(change: ActiveChange): Promise<void>;
  revert(id: string): Promise<void>;
  revertAll(): Promise<void>;
  enableMicrophone(): void;
  openDebug(): void;
  readAloud(): void;
  stopSpeaking(): void;
  isSpeaking(): boolean;
  settings: SettingsContext;
  ensureAlive(): boolean;
  suggest(): Promise<Suggestion | null>;
  acceptSuggestion(suggestion: Suggestion): void;
  dismissSuggestion(suggestion: Suggestion): void;
}

// "history" is the change history on this page; "session" is a saved request and its replies.
type View = "list" | "run" | "settings" | "history" | "commands" | "session";

interface Item {
  id: string;
  icon: IconName;
  title: string;
  hint?: string;
  kind: "ask" | "command" | "undo" | "try" | "saved" | "previous";
  section: string;
  keywords?: string;
  run(): void | Promise<void>;
}

interface Step {
  text: string;
  tone: "info" | "good" | "warn" | "bad";
}

type MemoryStatus = "proposed" | "remembered" | "rejected" | "forgotten";

interface MemoryEntry {
  line: string;
  status: MemoryStatus;
  host?: string;
  scope?: MemoryScope;
  outcome?: string;
}

interface RunState {
  runId: string | null;
  message: string;
  thread?: string;
  interrupt: boolean;
  status: "pending" | "queued" | "running" | "done";
  steps: Step[];
  memory: MemoryEntry[];
  options?: { question: string; options: OptionChoice[] };
  model?: string;
  tier?: string;
  startedAt: number;
  endedAt?: number;
  result?: { kind: "done" | "error" | "blocked"; text: string; applied: AppliedSummary[] };
  open: boolean;
  expanded: boolean;
  shownSteps: number;
  shownResult: boolean;
  seen: boolean;
  saving: boolean;
}

const MAX_THREAD = 6;
const AUTO_CLOSE_MS = 9000;
const ROUTING_ORDER: Routing[] = ["auto", "fast", "frontier"];
const BACK_VIEWS: View[] = ["settings", "history", "commands", "session"];

export class Spotlight {
  private layer = h("div", "sp");
  private scrim = h("div", "scrim");
  private bar = h("div", "bar");
  private orb = h("div", "orb");
  private input = h("input", "input");
  private home = h("button", "home");
  private pill = h("button", "pill");
  private body = h("div", "body");
  private hints = h("div", "hints");
  private view: View = "list";
  private items: Item[] = [];
  private selected = 0;
  private runs: RunState[] = [];
  private sessionRequest = "";
  private opened = false;
  private closeTimer: number | undefined;
  private disposeSettings: (() => void) | null = null;
  private animateBody = true;
  private cache: StoredState | null = null;
  private status: StatusInfo | null = null;
  private previousFocus: HTMLElement | null = null;
  private placeholder = "Ask anything  ·  / for commands";
  private mic = micButton();
  private live = liveRegion();
  private voiceBase = "";
  private voice = new VoiceController({
    onState: (state) => this.onVoiceState(state),
    onInterim: (text) => (this.input.value = joinVoiceText(this.voiceBase, text)),
    onFinal: (text) => this.onVoiceFinal(text),
  });

  constructor(
    private shadow: ShadowRoot,
    private deps: SpotlightDeps,
    private onToggle: (open: boolean) => void,
  ) {
    this.bar.setAttribute("role", "dialog");
    this.bar.setAttribute("aria-label", "Adaptive agent");
    this.bar.setAttribute("aria-modal", "true");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-label", "Ask the agent, or type / for commands");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.body.setAttribute("role", "listbox");
    this.pill.type = "button";
    this.home.type = "button";
    this.home.append(icon("back", 13), document.createTextNode("Home"));
    this.home.setAttribute("aria-label", "Home (Esc)");

    this.mic.addEventListener("click", () => {
      if (this.voice.active) this.toggleVoice();
      else void this.startVoice().catch(reportExtensionError);
    });
    this.bar.append(h("div", "row", "", [this.orb, this.input, this.mic, this.home, this.pill]), this.body, this.hints, this.live);
    this.layer.append(this.scrim, this.bar);
    shadow.append(this.layer);

    this.scrim.addEventListener("click", () => this.hide());
    this.input.addEventListener("input", () => this.onInput());
    this.home.addEventListener("click", () => this.goHome());
    this.pill.addEventListener("click", () => (BACK_VIEWS.includes(this.view) ? this.goHome() : void this.cycleModel()));
    this.bar.addEventListener("pointerenter", () => window.clearTimeout(this.closeTimer));
    this.input.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.opened && this.view === "list" && !this.shadow.activeElement) this.input.focus({ preventScroll: true });
      }, 0);
    });
    chrome.storage.onChanged.addListener(this.onStorage);
    addEventListener("pointerdown", this.onOutsidePointer, true);
  }

  private onStorage = () => void this.refreshCache().catch(reportExtensionError);

  private onOutsidePointer = (event: PointerEvent) => {
    if (this.opened && !event.composedPath().includes(this.shadow.host)) this.hide();
  };

  destroy() {
    removeEventListener("pointerdown", this.onOutsidePointer, true);
    try {
      chrome.storage.onChanged.removeListener(this.onStorage);
    } catch {
      // the extension context is already gone
    }
    this.voice.stop();
    window.clearTimeout(this.closeTimer);
    this.stopTicker();
    this.disposeSettings?.();
  }

  isOpen() {
    return this.opened;
  }

  get working() {
    return this.runs.some((run) => run.status !== "done");
  }

  private async refreshCache() {
    this.cache = await load();
    this.renderPill();
    if (this.opened && this.view === "list") this.renderList();
  }

  toggle() {
    if (this.opened) this.hide();
    else void this.show().catch(reportExtensionError);
  }

  async show(view?: View) {
    if (!this.deps.ensureAlive()) return;
    this.previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    await this.refreshCache();
    void this.deps.settings.getStatus().then((status) => {
      this.status = status;
      this.renderPill();
    });
    this.opened = true;
    if (!this.pinnedNudge) this.smartSuggestion = null;
    void this.deps.suggest().then((suggestion) => {
      if (!suggestion || this.pinnedNudge) return;
      this.smartSuggestion = suggestion;
      if (this.opened && this.view === "list" && !this.input.value) {
        this.animateBody = true;
        this.renderList();
        this.animateBody = false;
      }
    });
    this.input.value = "";
    this.selected = 0;
    this.setView(view ?? (this.working ? "run" : "list"));
    this.layer.classList.add("open");
    this.onToggle(true);
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  hide() {
    if (!this.opened) return;
    this.voice.stop();
    this.opened = false;
    window.clearTimeout(this.closeTimer);
    this.layer.classList.remove("open");
    this.disposeSettings?.();
    this.disposeSettings = null;
    this.onToggle(false);
    this.input.blur();
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = null;
  }

  private setView(view: View) {
    if (this.view === "settings" && view !== "settings") {
      this.disposeSettings?.();
      this.disposeSettings = null;
    }
    this.view = view;
    if (view === "settings" || view === "history" || view === "commands" || view === "session") this.input.value = "";
    if (view === "commands") this.commandSelected = 0;
    if (view === "history") this.historySelected = 0;
    this.animateBody = true;
    this.render();
  }

  private goHome() {
    window.clearTimeout(this.closeTimer);
    this.sessionRequest = "";
    this.setView("list");
    this.input.focus({ preventScroll: true });
  }

  private render() {
    this.layer.classList.toggle("running", this.view === "run");
    this.input.readOnly = this.view === "settings" || this.view === "history" || this.view === "commands";
    this.mic.disabled = this.input.readOnly;
    this.input.placeholder =
      this.view === "settings"
        ? "Settings"
        : this.view === "history"
          ? "Changes on this page  ·  Space to turn on or off"
          : this.view === "commands"
            ? "Saved commands  ·  Enter to run  ·  Space for every site"
            : this.view === "session"
              ? "Continue this session"
              : this.view === "run"
                ? this.working ? "Add another request" : "Ask a follow-up"
                : this.placeholder;
    this.orb.classList.toggle("work", this.working);
    this.home.hidden = this.view !== "run";
    this.renderPill();
    if (this.view === "settings") this.renderSettingsView();
    else if (this.view === "history") this.renderHistory();
    else if (this.view === "commands") this.renderCommands();
    else if (this.view === "session") this.renderSession();
    else if (this.view === "run") this.renderRun();
    else this.renderList();
    this.renderHints();
    this.animateBody = false;
  }

  private renderPill() {
    if (BACK_VIEWS.includes(this.view)) {
      this.pill.className = "pill";
      this.pill.replaceChildren(icon("back", 13), document.createTextNode("Back"));
      this.pill.title = "Back (Esc)";
      this.pill.setAttribute("aria-label", "Back");
      return;
    }
    const routing: Routing = this.cache?.routing ?? "auto";
    const models = this.status?.models;
    this.pill.className = `pill${routing === "frontier" ? " pro" : ""}`;
    this.pill.replaceChildren(icon(routing === "frontier" ? "sparkle" : "bolt", 13), document.createTextNode(ROUTING_LABELS[routing]), h("span", "k", "⇥"));
    const detail = models ? ` (Fast: ${models.fast}, Pro: ${models.frontier})` : "";
    this.pill.title = `Model: ${ROUTING_LABELS[routing]}. Tab to switch${detail}`;
    this.pill.setAttribute("aria-label", `Model ${ROUTING_LABELS[routing]}, press Tab to switch`);
  }

  private async setRouting(next: Routing) {
    if (this.cache) this.cache.routing = next;
    this.renderPill();
    this.pill.classList.remove("flip");
    void this.pill.offsetWidth;
    this.pill.classList.add("flip");
    await save({ routing: next });
  }

  private cycleModel() {
    const routing: Routing = this.cache?.routing ?? "auto";
    return this.setRouting(ROUTING_ORDER[(ROUTING_ORDER.indexOf(routing) + 1) % ROUTING_ORDER.length]);
  }

  // While a request runs, typing offers Send now (interrupt) or Queue for later.
  private renderHints() {
    const text = this.input.value.trim();
    const show = this.working && !!text && !this.input.readOnly;
    this.hints.hidden = !show;
    if (!show) return;
    const button = (label: string, action: () => void) => {
      const control = h("button", "link", label);
      control.type = "button";
      control.addEventListener("click", action);
      return control;
    };
    this.hints.replaceChildren(
      button("Send now", () => this.ask(this.input.value.trim(), false, true)),
      h("span", "", "", [h("b", "", "Ctrl/⌘ + Enter")]),
      h("span", "grow"),
      button("Queue for later", () => this.queueRequest()),
      h("span", "", "", [h("b", "", "Alt/Option + Enter")]),
    );
  }

  private smartSuggestion: Suggestion | null = null;
  // A nudge from noticed friction stays until answered; a plain suggestion refreshes on every open.
  private pinnedNudge = false;

  // A friction nudge replaces whatever suggest() returned; the bar shows it pre-selected.
  setNudge(suggestion: Suggestion | null) {
    this.smartSuggestion = suggestion;
    this.pinnedNudge = suggestion !== null;
    if (this.opened && this.view === "list" && !this.input.value) {
      this.animateBody = true;
      this.renderList();
      this.animateBody = false;
    }
  }

  private suggestion(): Item | null {
    const suggestion = this.smartSuggestion;
    if (!suggestion) return null;
    return {
      id: `try:${suggestion.text}`,
      icon: "sparkle",
      title: suggestion.text,
      hint: suggestion.reason || "suggested",
      kind: "try",
      section: "",
      run: () => {
        this.deps.acceptSuggestion(suggestion);
        this.smartSuggestion = null;
        this.pinnedNudge = false;
        this.ask(suggestion.text, false);
      },
    };
  }

  private onInput() {
    window.clearTimeout(this.closeTimer);
    if (this.view === "run" && !this.working) this.setView("list");
    if (this.view !== "list") return this.renderHints();
    this.selected = 0;
    this.renderList();
    this.renderHints();
  }

  private commands(changes: ActiveChange[]): Item[] {
    const state = this.cache;
    const routing: Routing = state?.routing ?? "auto";
    const next = ROUTING_ORDER[(ROUTING_ORDER.indexOf(routing) + 1) % ROUTING_ORDER.length];
    return [
      { id: "commands", icon: "bookmark", title: "Saved commands", hint: "→", kind: "command", section: "Commands", keywords: "shortcuts presets saved favorites", run: () => this.setView("commands") },
      { id: "history", icon: "history", title: "Change history", hint: "→", kind: "command", section: "Commands", keywords: "changes log toggle before after compare", run: () => this.setView("history") },
      { id: "settings", icon: "settings", title: "Settings", kind: "command", section: "Commands", keywords: "preferences profile model options", run: () => this.setView("settings") },
      ...(changes.length ? [{ id: "undo-all", icon: "undo" as IconName, title: "Undo all changes on this page", kind: "command" as const, section: "Commands", keywords: "revert reset", run: async () => (await this.deps.revertAll(), this.hide()) }] : []),
      ...(this.deps.isSpeaking()
        ? [{ id: "stop-reading", icon: "pause" as IconName, title: "Stop reading aloud", hint: "esc", kind: "command" as const, section: "Commands", keywords: "speech tts silence quiet", run: () => (this.deps.stopSpeaking(), this.hide()) }]
        : [{ id: "read-aloud", icon: "volume" as IconName, title: "Read this page aloud", hint: "main text", kind: "command" as const, section: "Commands", keywords: "speech tts speak listen narrate", run: () => (this.deps.readAloud(), this.hide()) }]),
      {
        id: "pause",
        icon: state?.paused ? "play" : "pause",
        title: state?.paused ? "Resume adaptations" : "Pause adaptations",
        hint: "master switch",
        kind: "command",
        section: "Commands",
        keywords: "kill switch off on disable enable",
        run: async () => (await save({ paused: !state?.paused }), this.hide()),
      },
      {
        id: "fab",
        icon: "circle",
        title: state?.floatingButton === false ? "Show floating widget" : "Hide floating widget",
        kind: "command",
        section: "Commands",
        keywords: "orb launcher floating button",
        run: async () => (await save({ floatingButton: state?.floatingButton === false }), this.hide()),
      },
      { id: "model", icon: "bolt", title: "Switch model", hint: `${ROUTING_LABELS[routing]} → ${ROUTING_LABELS[next]}`, kind: "command", section: "Commands", keywords: "fast pro auto smart frontier routing", run: () => this.cycleModel() },
      ...ROUTING_ORDER.map((value): Item => ({
        id: `model:${value}`,
        icon: "bolt",
        title: value === "auto" ? "Model: choose automatically" : `Model: always use ${ROUTING_LABELS[value]}`,
        hint: routing === value ? "current" : undefined,
        kind: "command",
        section: "Commands",
        keywords: "switch change routing fast pro frontier auto smart quick",
        run: () => this.setRouting(value),
      })),
      {
        id: "enable-microphone",
        icon: "mic",
        title: "Enable microphone",
        hint: "All supported websites",
        kind: "command",
        section: "Commands",
        keywords: "voice input mic permission settings all websites",
        run: () => (this.deps.enableMicrophone(), this.hide()),
      },
      { id: "debug", icon: "bug", title: "Open debug panel", kind: "command", section: "Commands", keywords: "developer console logs chat", run: () => (this.deps.openDebug(), this.hide()) },
      {
        id: "clear-chat",
        icon: "text",
        title: "Clear chat",
        hint: "memory is kept",
        kind: "command",
        section: "Commands",
        keywords: "history reset conversation requests",
        run: async () => {
          await save({ history: [], submittedRequests: [], requestSessions: [] });
          this.runs = this.runs.filter((run) => run.status !== "done");
        },
      },
    ];
  }

  private buildItems(): Item[] {
    const raw = this.input.value.trim();
    const changes = this.deps.listChanges();
    const undo: Item[] = changes.map((change) => ({
      id: `undo:${change.id}`,
      icon: "undo",
      title: `Undo ${change.summary.charAt(0).toLowerCase()}${change.summary.slice(1)}`,
      hint: change.scope === "everywhere" ? "all sites" : undefined,
      kind: "undo",
      section: "On this page",
      keywords: "revert remove",
      run: () => this.deps.revert(change.id),
    }));

    if (!raw) {
      const last = [...changes].sort((a, b) => b.appliedAt - a.appliedAt)[0];
      const items: Item[] = [];
      const suggestion = this.suggestion();
      if (suggestion) items.push(suggestion);
      if (last) items.push({ id: "undo-last", icon: "undo", title: `Undo ${last.summary.charAt(0).toLowerCase()}${last.summary.slice(1)}`, hint: "→ history", kind: "undo", section: "", run: () => this.deps.revert(last.id) });
      return items;
    }

    const isCommand = raw.startsWith("/");
    const query = (isCommand ? raw.slice(1) : raw).trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = (item: Item) => tokens.every((token) => `${item.title} ${item.keywords ?? ""}`.toLowerCase().includes(token));
    const saved: Item[] = (this.cache?.commands ?? []).map((command) => ({
      id: `saved:${command.id}`,
      icon: "bookmark",
      title: command.name,
      hint: command.everywhere ? "every site" : "command",
      kind: "saved",
      section: "Saved",
      keywords: command.prompt,
      run: () => this.ask(command.prompt, false),
    }));
    const pool = [...saved, ...undo, ...this.commands(changes)];
    if (isCommand) return pool.filter(matches).slice(0, 8);

    const previous: Item[] = this.cache
      ? suggestRequests(this.cache, raw).slice(0, 3).map((text) => ({
          id: `previous:${text}`,
          icon: "text",
          title: text,
          hint: "Open request history",
          kind: "previous",
          section: "",
          run: () => this.openSession(text),
        }))
      : [];
    const matched = pool.filter(matches);
    const ask: Item = { id: "ask", icon: "sparkle", title: raw, hint: "Ask", kind: "ask", section: "", run: () => this.ask(raw, false) };
    const strong = query.length >= 2 ? matched.find((item) => item.title.toLowerCase().startsWith(query)) : undefined;
    return (strong ? [strong, ask, ...previous, ...matched.filter((item) => item !== strong)] : [ask, ...previous, ...matched]).slice(0, 6);
  }

  private renderList() {
    this.items = this.buildItems();
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    const nodes: Node[] = [];
    this.items.forEach((item, index) => {
      const row = h("div", `item${index === this.selected ? " sel" : ""}`, "", [icon(item.icon, 15), h("span", "title", item.title), item.hint ? h("span", "hint", item.hint) : null]);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.selected));
      row.dataset.index = String(index);
      row.style.setProperty("--i", String(index));
      row.addEventListener("pointermove", () => this.select(index, false));
      row.addEventListener("click", () => void this.runItem(item));
      if (item.kind !== "previous") return void nodes.push(row);
      const remove = h("button", "x delete-request", "", [icon("trash", 12)]);
      remove.type = "button";
      remove.title = "Delete saved request";
      remove.tabIndex = -1;
      remove.setAttribute("aria-label", `Delete saved request: ${item.title}`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.deleteSuggestion(item.title);
      });
      const group = h("div", "request-row", "", [row, remove]);
      group.setAttribute("role", "presentation");
      nodes.push(group);
    });
    this.body.classList.toggle("enter", this.animateBody);
    this.body.replaceChildren(...nodes);
  }

  private async deleteSuggestion(message: string) {
    this.input.focus({ preventScroll: true });
    try {
      await deleteRequest(message);
      await this.refreshCache();
      this.live.textContent = "Saved request deleted.";
    } catch {
      this.live.textContent = "Could not delete the saved request.";
      this.live.classList.remove("sr-only");
    }
  }

  private select(index: number, scroll = true) {
    if (index === this.selected) return;
    this.selected = index;
    for (const row of this.body.querySelectorAll<HTMLElement>(".item")) {
      const active = Number(row.dataset.index) === index;
      row.classList.toggle("sel", active);
      row.setAttribute("aria-selected", String(active));
      if (active && scroll) row.scrollIntoView({ block: "nearest" });
    }
  }

  private async runItem(item: Item) {
    await item.run();
    if (this.opened && this.view === "list") this.renderList();
  }

  private async openSession(message: string) {
    this.cache = await load();
    if (!this.opened) return;
    this.sessionRequest = message;
    this.setView("session");
    this.input.focus({ preventScroll: true });
  }

  private renderSession() {
    const sessions = this.cache ? findRequestSessions(this.cache, this.sessionRequest) : [];
    const retry = h("button", "link", "Use request again");
    retry.type = "button";
    retry.addEventListener("click", () => {
      const request = this.sessionRequest;
      this.setView("list");
      this.input.value = request;
      this.onInput();
      this.input.focus({ preventScroll: true });
    });
    this.body.classList.toggle("enter", this.animateBody);
    this.body.replaceChildren(
      h("div", "session", "", [
        h("div", "sec", "Request history"),
        ...sessions.flatMap(({ message, reply, outcome, options }) => [
          h("p", "you", message),
          h("div", `result ${outcome === "done" ? "" : "error"}`, "", [icon(outcome === "done" ? "check" : "x", 15), h("span", "", reply || "Done.")]),
          ...(options ? [this.optionsBlock(options.question, options.options, this.sessionRequest)] : []),
        ]),
        ...(sessions.length ? [] : [h("p", "you", "No reply was saved for this request.")]),
        retry,
      ]),
    );
  }

  ask(message: string, fresh: boolean, interrupt = false, thread = this.sessionRequest) {
    if (!message) return;
    window.clearTimeout(this.closeTimer);
    for (const run of this.runs) if (run.status === "done") run.open = false;
    this.runs.push({
      runId: null, message, thread: thread || undefined, interrupt, status: "pending", steps: [{ text: "Reading the page", tone: "info" }], memory: [],
      startedAt: Date.now(), open: true, expanded: false, shownSteps: 0, shownResult: false, seen: false, saving: false,
    });
    while (this.runs.length > MAX_THREAD) {
      const oldest = this.runs.findIndex((run) => run.status === "done");
      if (oldest < 0) break;
      this.runs.splice(oldest, 1);
    }
    this.input.value = "";
    this.sessionRequest = thread;
    this.setView("run");
    this.deps.ask(message, fresh, interrupt, thread || undefined);
  }

  // Idle: sends right away. Busy: the background queues it and drains the queue after each successful reply.
  private queueRequest() {
    const message = this.input.value.trim();
    if (!message) return;
    const busy = this.working;
    this.ask(message, false);
    if (busy) this.live.textContent = "Request queued for later.";
  }

  private elapsed(run: RunState) {
    return `${(((run.endedAt ?? Date.now()) - run.startedAt) / 1000).toFixed(1)}s`;
  }

  private stepNodes(run: RunState, live: boolean): Node[] {
    const currentTask = live ? run.steps.map((step) => step.tone).lastIndexOf("info") : -1;
    const nodes = run.steps.map((step, index) => {
      const current = index === currentTask;
      const mark = current ? h("span", "spin") : icon(step.tone === "bad" ? "x" : step.tone === "warn" ? "circle" : "check", 12);
      return h("li", `st ${step.tone}${step.tone !== "info" ? " out" : ""}${current ? " now" : ""}${index >= run.shownSteps ? " new" : ""}`, "", [mark, h("span", "t", step.text)]);
    });
    run.shownSteps = run.steps.length;
    return live ? nodes.slice(-6) : nodes;
  }

  private renderRun() {
    this.body.classList.remove("enter");
    const busy = this.runs.some((run) => run.status === "running");
    this.body.replaceChildren(h("div", "thread", "", this.runs.map((run) => this.renderCard(run, busy))));
    (this.body.querySelector(".card.active") ?? this.body.querySelector(".card:last-child"))?.scrollIntoView({ block: "nearest" });
    if (this.runs.some((run) => run.status === "running" || run.status === "pending")) this.startTicker();
    else this.stopTicker();
    // Re-rendering removes the focused button; keep keyboard focus inside the bar.
    if (this.opened && !this.shadow.activeElement) this.input.focus({ preventScroll: true });
  }

  private renderCard(run: RunState, busy: boolean): HTMLElement {
    const enter = run.seen ? "" : " enter";
    run.seen = true;

    if (run.status === "queued" || (run.status === "pending" && busy && !run.interrupt)) {
      const sendNow = h("button", "link", "Send now");
      sendNow.type = "button";
      sendNow.setAttribute("aria-label", `Send "${run.message}" now`);
      sendNow.addEventListener("click", () => {
        if (run.runId) this.deps.dequeue(run.runId);
        this.runs = this.runs.filter((other) => other !== run);
        const draft = this.input.value;
        this.ask(run.message, false, true, run.thread ?? "");
        this.input.value = draft;
      });
      const remove = h("button", "x", "", [icon("x", 12)]);
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove "${run.message}" from the queue`);
      remove.addEventListener("click", () => {
        if (run.runId) this.deps.dequeue(run.runId);
        this.runs = this.runs.filter((other) => other !== run);
        this.renderRun();
      });
      return h("div", `card queued${enter}`, "", [h("span", "next", "Next"), h("span", "q", run.message), sendNow, remove]);
    }

    if (run.status === "done" && !run.open && run.result) {
      const { kind, applied } = run.result;
      const summary = kind === "done" ? (applied.length ? `${applied.length} change${applied.length === 1 ? "" : "s"}` : "no changes") : kind === "blocked" ? "blocked" : "stopped or failed";
      const row = h("button", `card mini-card ${kind}${enter}`, "", [icon(kind === "done" ? "check" : kind === "blocked" ? "shield" : "x", 13), h("span", "q", run.message), h("span", "meta", summary)]);
      row.type = "button";
      row.setAttribute("aria-label", `${run.message}: ${summary}. Show details`);
      row.addEventListener("click", () => {
        run.open = true;
        this.renderRun();
      });
      return row;
    }

    const live = run.status !== "done";
    const head = h("div", "ask-line", "", [h("span", "q", run.message)]);
    const memory = run.memory.length ? [h("div", "memory", "", run.memory.map((entry) => this.memoryCard(entry)))] : [];
    if (live) {
      const stop = h("button", "link stop", "Stop");
      stop.type = "button";
      stop.addEventListener("click", () => {
        stop.disabled = true;
        this.deps.stop();
      });
      head.append(h("span", "meta", `${this.elapsed(run)}${run.model ? ` · ${run.model}` : ""}`), stop);
      return h("div", `card active${enter}`, "", [head, h("ul", "steps", "", this.stepNodes(run, true)), ...memory]);
    }

    const hide = h("button", "link quiet", "Hide");
    hide.type = "button";
    hide.addEventListener("click", () => {
      run.open = false;
      run.expanded = false;
      this.renderRun();
    });
    head.append(hide);
    const { kind, text, applied } = run.result!;
    const children: Node[] = [head, h("div", `result ${kind === "done" ? "" : kind}${run.shownResult ? "" : " new"}`, "", [icon(kind === "done" ? "check" : kind === "blocked" ? "shield" : "x", 15), h("span", "", text)])];
    run.shownResult = true;
    if (applied.length) {
      children.push(
        h(
          "div",
          "changes",
          "",
          applied.map((change) => {
            const undo = h("button", "link", "Undo");
            undo.type = "button";
            undo.setAttribute("aria-label", `Undo ${change.summary}`);
            const row = h("div", "chg", "", [h("b", "", change.summary), h("span", "why", change.reason), undo]);
            row.title = `Because: ${change.reason}${change.scope === "everywhere" ? " (all sites)" : ""}`;
            undo.addEventListener("click", async () => {
              await this.deps.revert(change.id);
              row.classList.add("gone");
              undo.remove();
            });
            return row;
          }),
        ),
      );
    }
    if (run.options) children.push(this.optionsBlock(run.options.question, run.options.options, run.thread ?? run.message));
    children.push(...memory);
    const count = run.steps.filter((step) => step.tone === "info").length;
    const fold = h("button", "fold", `${run.expanded ? "Hide" : "Show"} ${count} step${count === 1 ? "" : "s"} · ${this.elapsed(run)}${run.model ? ` · ${run.model}` : ""}`);
    fold.type = "button";
    fold.setAttribute("aria-expanded", String(run.expanded));
    fold.addEventListener("click", () => {
      run.expanded = !run.expanded;
      run.shownSteps = run.expanded ? 0 : run.steps.length;
      this.renderRun();
    });
    const footer = h("div", "card-foot", "", [fold]);
    const alreadySaved = (this.cache?.commands ?? []).some((command) => command.prompt.toLowerCase() === run.message.toLowerCase());
    if (kind === "done" && applied.length && !alreadySaved && !run.saving) {
      const saveButton = h("button", "fold", "", [icon("bookmark", 11), document.createTextNode(" Save as command")]);
      saveButton.type = "button";
      saveButton.addEventListener("click", () => {
        run.saving = true;
        this.renderRun();
      });
      footer.append(saveButton);
    } else if (alreadySaved) {
      footer.append(h("span", "fold saved", "Saved as a command"));
    }
    children.push(footer);
    if (run.saving) children.push(this.saveForm(run));
    if (run.expanded) children.push(h("ul", "steps done", "", this.stepNodes(run, false)));
    return h("div", `card open${enter}`, "", children);
  }

  // Each option runs as a follow-up in the same session; Edit lets the user reword it before it runs.
  private optionsBlock(question: string, options: OptionChoice[], thread: string): HTMLElement {
    const block = h("div", "options", "", [h("div", "options-q", question)]);
    block.setAttribute("role", "group");
    block.setAttribute("aria-label", question);
    for (const option of options) {
      const row = h("div", "option");
      const pick = h("button", "option-pick", "", [h("b", "", option.label), h("span", "", option.request)]);
      pick.type = "button";
      pick.addEventListener("click", () => this.ask(option.request, false, false, thread));
      const edit = h("button", "link quiet", "Edit");
      edit.type = "button";
      edit.setAttribute("aria-label", `Edit option: ${option.label}`);
      const show = () => row.replaceChildren(pick, edit);
      edit.addEventListener("click", () => {
        const input = h("input", "option-input");
        input.value = option.request;
        input.setAttribute("aria-label", `Edit request for ${option.label}`);
        input.spellcheck = false;
        const run = h("button", "link", "Run");
        run.type = "submit";
        const cancel = h("button", "link quiet", "Cancel");
        cancel.type = "button";
        const form = h("form", "option-edit", "", [input, run, cancel]);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (text) this.ask(text, false, false, thread);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          show();
          edit.focus({ preventScroll: true });
        });
        cancel.addEventListener("click", () => (show(), edit.focus({ preventScroll: true })));
        row.replaceChildren(form);
        queueMicrotask(() => (input.focus(), input.select()));
      });
      show();
      block.append(row);
    }
    return block;
  }

  private memoryCard(entry: MemoryEntry) {
    const act = (label: string, status: MemoryStatus, change: (line: string) => Promise<void>) => {
      const button = h("button", "link", label);
      button.type = "button";
      button.addEventListener("click", async () => {
        await change(entry.line);
        entry.status = status;
        this.render();
      });
      return button;
    };
    const choices = entry.status === "proposed"
      ? scopeChoices([entry.line], entry.host, entry.scope).map((choice) => {
          const button = h("button", `link${choice.suggested ? "" : " quiet"}`, choice.label);
          button.type = "button";
          button.addEventListener("click", async () => {
            const outcome = await choice.run();
            entry.status = outcome.saved ? "remembered" : "rejected";
            entry.outcome = outcomeText(outcome, entry.host);
            entry.line = outcome.saved && outcome.scope === "site" && entry.host ? `On ${entry.host}: ${entry.line}` : entry.line;
            this.render();
          });
          return button;
        })
      : [];
    const actions = entry.status === "remembered" ? [act("Undo", "forgotten", forgetLine)] : choices;
    const label = entry.status === "forgotten" ? "Forgotten" : entry.outcome ?? { proposed: "Save this?", remembered: "Remembered", rejected: "Not saved", forgotten: "Forgotten" }[entry.status];
    const inactive = entry.status === "rejected" || entry.status === "forgotten";
    return h("div", `chg${inactive ? " gone" : ""}`, "", [h("b", "", entry.line), h("span", "tag", label), ...actions]);
  }

  private saveForm(run: RunState): HTMLElement {
    const input = h("input", "name-input");
    input.value = run.message.length > 40 ? `${run.message.slice(0, 37)}...` : run.message;
    input.setAttribute("aria-label", "Command name");
    input.spellcheck = false;
    const everywhere = h("button", "mini-toggle", "Every site");
    everywhere.type = "button";
    everywhere.setAttribute("aria-pressed", "false");
    everywhere.addEventListener("click", () => everywhere.setAttribute("aria-pressed", String(everywhere.getAttribute("aria-pressed") !== "true")));
    const saveButton = h("button", "link", "Save");
    saveButton.type = "button";
    const cancel = h("button", "link quiet", "Cancel");
    cancel.type = "button";
    const commit = async () => {
      const name = input.value.trim() || run.message;
      const command: SavedCommand = { id: crypto.randomUUID(), name, prompt: run.message, everywhere: everywhere.getAttribute("aria-pressed") === "true", appliedOrigins: [location.origin], createdAt: Date.now() };
      await save({ commands: [...((await load()).commands ?? []), command] });
      run.saving = false;
      this.cache = await load();
      this.renderRun();
    };
    saveButton.addEventListener("click", () => void commit());
    cancel.addEventListener("click", () => {
      run.saving = false;
      this.renderRun();
    });
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    const form = h("form", "save-form", "", [icon("bookmark", 13), input, everywhere, saveButton, cancel]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void commit();
    });
    return form;
  }

  private commandSelected = 0;

  private renderCommands() {
    const commands = this.cache?.commands ?? [];
    this.body.classList.toggle("enter", this.animateBody);
    if (!commands.length) {
      this.body.replaceChildren(h("div", "empty", "No saved commands yet. After a request works, choose Save as command."));
      return;
    }
    this.commandSelected = Math.min(this.commandSelected, commands.length - 1);
    const rows = commands.map((command, index) => {
      const remove = h("button", "x", "", [icon("x", 12)]);
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete command ${command.name}`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.deleteCommand(command.id);
      });
      const toggle = h("span", `mini${command.everywhere ? " on" : ""}`);
      toggle.title = "Run on every site";
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.toggleEverywhere(command.id);
      });
      const row = h("div", `hrow item${index === this.commandSelected ? " sel" : ""}`, "", [
        icon("bookmark", 14),
        h("div", "hmain", "", [h("span", "ht", command.name), h("span", "hr", command.prompt)]),
        h("span", "hint", command.everywhere ? "every site" : ""),
        toggle,
        remove,
      ]);
      row.setAttribute("role", "option");
      row.setAttribute("aria-label", `${command.name}${command.everywhere ? ", runs on every site" : ""}`);
      row.style.setProperty("--i", String(index));
      row.addEventListener("pointermove", () => {
        if (this.commandSelected === index) return;
        this.commandSelected = index;
        this.body.querySelectorAll(".hrow").forEach((other, i) => other.classList.toggle("sel", i === index));
      });
      row.addEventListener("click", () => this.ask(command.prompt, false));
      return row;
    });
    this.body.replaceChildren(...rows);
  }

  private async toggleEverywhere(id: string) {
    const { commands } = await load();
    await save({ commands: commands.map((command) => (command.id === id ? { ...command, everywhere: !command.everywhere } : command)) });
    this.cache = await load();
    if (this.view === "commands") this.renderCommands();
  }

  private async deleteCommand(id: string) {
    const { commands } = await load();
    await save({ commands: commands.filter((command) => command.id !== id) });
    this.cache = await load();
    if (this.view === "commands") this.renderCommands();
  }

  private ticker: number | undefined;

  private startTicker() {
    if (this.ticker !== undefined) return;
    this.ticker = window.setInterval(() => {
      const run = this.runs.find((candidate) => candidate.status === "running");
      const meta = this.body.querySelector<HTMLElement>(".card.active .meta");
      if (!run || !meta) return;
      meta.textContent = `${this.elapsed(run)}${run.model ? ` · ${run.model}` : ""}`;
    }, 100);
  }

  private stopTicker() {
    window.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private historySelected = 0;

  private ago(at: number) {
    const seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return "earlier";
  }

  private renderHistory() {
    const entries = this.deps.history();
    this.body.classList.toggle("enter", this.animateBody);
    if (!entries.length) {
      this.body.replaceChildren(h("div", "empty", "No changes on this page yet."));
      return;
    }
    this.historySelected = Math.min(this.historySelected, entries.length - 1);
    const rows = entries.map(({ change, active }, index) => {
      const row = h("div", `hrow item${index === this.historySelected ? " sel" : ""}${active ? "" : " off"}`, "", [
        h("span", `mini${active ? " on" : ""}`),
        h("div", "hmain", "", [h("span", "ht", change.summary), h("span", "hr", change.reason)]),
        h("span", "hint", `${this.ago(change.appliedAt)}${change.scope === "everywhere" ? " · all sites" : ""}`),
      ]);
      row.setAttribute("role", "switch");
      row.setAttribute("aria-checked", String(active));
      row.setAttribute("aria-label", `${change.summary}, ${active ? "on" : "off"}`);
      row.style.setProperty("--i", String(index));
      row.addEventListener("pointermove", () => {
        if (this.historySelected === index) return;
        this.historySelected = index;
        this.body.querySelectorAll(".hrow").forEach((other, i) => other.classList.toggle("sel", i === index));
      });
      row.addEventListener("click", () => void this.toggleHistory(index));
      return row;
    });
    this.body.replaceChildren(...rows);
  }

  private async toggleHistory(index: number) {
    const entry = this.deps.history()[index];
    if (!entry) return;
    this.historySelected = index;
    if (entry.active) await this.deps.revert(entry.change.id);
    else await this.deps.reapply(entry.change);
    if (this.view === "history") this.renderHistory();
  }

  private moveHistory(step: number) {
    const count = this.deps.history().length;
    if (!count) return;
    this.historySelected = (this.historySelected + step + count) % count;
    this.body.querySelectorAll<HTMLElement>(".hrow").forEach((row, i) => {
      row.classList.toggle("sel", i === this.historySelected);
      if (i === this.historySelected) row.scrollIntoView({ block: "nearest" });
    });
  }

  private renderSettingsView() {
    this.disposeSettings?.();
    const container = h("div", "settings");
    this.body.classList.remove("enter");
    this.body.replaceChildren(container);
    this.disposeSettings = renderSettings(container, this.deps.settings);
  }

  handleEvent(event: UiEvent): boolean {
    let run: RunState | undefined;
    if (event.type === "queued" || event.type === "start") {
      if (event.type === "start" && event.trigger !== "chat") return false;
      run = this.runs.find((candidate) => candidate.runId === event.runId) ?? this.runs.find((candidate) => candidate.runId === null && candidate.status === "pending" && candidate.message === event.message);
      if (!run) return false;
      run.runId = event.runId;
      if (event.type === "queued") run.status = "queued";
      else {
        run.status = "running";
        run.startedAt = Date.now();
        run.steps = [{ text: "Reading the page", tone: "info" }];
        run.shownSteps = 0;
        for (const other of this.runs) if (other !== run && other.status === "done") other.open = false;
      }
    } else {
      run = this.runs.find((candidate) => candidate.runId === event.runId);
      if (!run) return false;
      switch (event.type) {
        case "step":
          run.steps.push({ text: event.text, tone: event.tone });
          break;
        case "tier":
          run.tier = event.tier;
          run.model = event.model;
          run.steps.push({ text: "Thinking", tone: "info" });
          break;
        case "options":
          run.options = { question: event.question, options: event.options };
          break;
        case "memory":
          run.memory.push(...event.lines.map((line) => ({ line, status: (event.status === "saved" ? "remembered" : "proposed") as MemoryStatus, host: event.host, scope: event.scope })));
          break;
        case "blocked":
          run.result = { kind: "blocked", text: `Blocked. This page tried to give the agent instructions: "${event.reason.slice(0, 90)}"`, applied: [] };
          break;
        case "done":
          if (!run.result) run.result = { kind: "done", text: event.reply || "Done.", applied: event.applied };
          break;
        case "error":
          run.result = { kind: "error", text: event.message, applied: [] };
          break;
        case "cancelled":
          if (run.status === "queued" || run.status === "pending") this.runs = this.runs.filter((other) => other !== run);
          else run.result = { kind: "error", text: event.reason ?? "Stopped.", applied: [] };
          break;
      }
      if (run.result && run.status !== "done") {
        run.status = "done";
        run.endedAt = Date.now();
      }
    }

    if (!this.opened) {
      this.orb.classList.toggle("work", this.working);
      return true;
    }
    if (this.view === "run") this.render();
    else this.orb.classList.toggle("work", this.working);
    if (!this.working && run.status === "done") {
      if (this.view === "run") this.input.focus({ preventScroll: true });
      window.clearTimeout(this.closeTimer);
      this.closeTimer = window.setTimeout(() => {
        if (this.opened && this.view === "run" && !this.working && !this.input.value && !this.voice.active && !this.bar.matches(":hover") && !this.runs.some((other) => other.expanded || other.saving || (other.options && other.open))) this.hide();
      }, AUTO_CLOSE_MS);
    }
    return true;
  }

  async startVoice() {
    if (!this.opened) await this.show();
    if (this.input.readOnly) this.setView("list");
    window.clearTimeout(this.closeTimer);
    this.input.focus({ preventScroll: true });
    if (!this.voice.active) this.toggleVoice();
  }

  private toggleVoice() {
    if (this.voice.active) {
      this.voice.stop();
      return;
    }
    this.voiceBase = this.input.value;
    void this.voice.start();
  }

  handleVoice(event: VoiceEvent) {
    this.voice.receive(event);
  }

  private onVoiceState(state: VoiceState) {
    paintMic(this.mic, state);
    if (this.opened) this.live.textContent = voiceStatusText(state);
    this.live.classList.toggle("sr-only", state.phase !== "error");
  }

  private onVoiceFinal(text: string) {
    if (!this.opened) return;
    const value = joinVoiceText(this.voiceBase, text);
    this.voiceBase = "";
    this.input.value = value;
    if (text && (this.cache?.voiceAutoSend ?? true)) return this.queueRequest();
    this.onInput();
    this.input.focus({ preventScroll: true });
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.opened || event.isComposing) return false;
    const { key } = event;
    const focused = this.shadow.activeElement;
    // Buttons and fields inside the bar handle their own keys (Enter on Undo, typing a command name); only Escape still closes.
    if (focused && focused !== this.input && key !== "Escape") return false;
    if (focused instanceof HTMLInputElement && focused.classList.contains("option-input")) return false;
    if (event.altKey && event.code === "KeyM" && !this.input.readOnly) {
      this.toggleVoice();
      return true;
    }
    if (key === "Escape") {
      if (this.voice.active) {
        this.voice.stop();
        return true;
      }
      if (this.view !== "list") this.goHome();
      else this.hide();
      return true;
    }
    const inSearchField = this.shadow.activeElement === this.input;
    if (this.view === "history") {
      if (key === "ArrowDown") return this.moveHistory(1), true;
      if (key === "ArrowUp") return this.moveHistory(-1), true;
      if (key === " " || key === "Enter") return void this.toggleHistory(this.historySelected), true;
      if (key === "Backspace" || key === "ArrowLeft") return this.goHome(), true;
    }
    if (this.view === "commands") {
      const commands = this.cache?.commands ?? [];
      const move = (step: number) => {
        if (!commands.length) return;
        this.commandSelected = (this.commandSelected + step + commands.length) % commands.length;
        this.body.querySelectorAll<HTMLElement>(".hrow").forEach((row, i) => {
          row.classList.toggle("sel", i === this.commandSelected);
          if (i === this.commandSelected) row.scrollIntoView({ block: "nearest" });
        });
      };
      if (key === "ArrowDown") return move(1), true;
      if (key === "ArrowUp") return move(-1), true;
      if (key === " " && commands[this.commandSelected]) return void this.toggleEverywhere(commands[this.commandSelected].id), true;
      if (key === "Enter" && commands[this.commandSelected]) return this.ask(commands[this.commandSelected].prompt, false), true;
      if (key === "Delete" && commands[this.commandSelected]) return void this.deleteCommand(commands[this.commandSelected].id), true;
      if (key === "Backspace" || key === "ArrowLeft") return this.goHome(), true;
    }
    if (!this.input.readOnly && key === "Enter" && (event.metaKey || event.ctrlKey)) {
      this.ask(this.input.value.trim(), false, true);
      return true;
    }
    if (!this.input.readOnly && key === "Enter" && event.altKey) {
      this.queueRequest();
      return true;
    }
    if (this.view === "list" && !this.input.value) {
      if (key === "ArrowRight" && this.deps.history().length) return this.setView("history"), true;
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
        const last = this.items.find((item) => item.id === "undo-last");
        if (last) void this.runItem(last);
        return true;
      }
    }
    if (key === "Backspace" && inSearchField && !this.input.value && (this.view === "settings" || this.view === "session" || (this.view === "run" && !this.working))) {
      this.goHome();
      return true;
    }
    // Tab switches the model only while typing; otherwise it moves focus so keyboard users can reach Undo and Save.
    const typing = inSearchField && (this.input.value.length > 0 || this.view === "list");
    if (key === "Tab" && typing && !this.input.readOnly && this.view !== "session") {
      void this.cycleModel();
      return true;
    }
    if (this.view === "list" && this.items.length) {
      if (key === "ArrowDown") return this.select((this.selected + 1) % this.items.length), true;
      if (key === "ArrowUp") return this.select((this.selected - 1 + this.items.length) % this.items.length), true;
      const item = this.items[this.selected];
      if (key === "Delete" && event.shiftKey && item?.kind === "previous") {
        void this.deleteSuggestion(item.title);
        return true;
      }
      if ((key === "Delete" || key === "Backspace") && !this.input.value && item?.kind === "try" && this.smartSuggestion) {
        this.deps.dismissSuggestion(this.smartSuggestion);
        this.smartSuggestion = null;
        this.pinnedNudge = false;
        this.renderList();
        return true;
      }
      if (key === "Enter") {
        if (event.shiftKey && item.kind === "ask") this.ask(this.input.value.trim(), true);
        else void this.runItem(item);
        return true;
      }
    }
    if ((this.view === "run" || this.view === "session") && key === "Enter") {
      const text = this.input.value.trim();
      if (text) this.ask(text, event.shiftKey);
      else this.hide();
      return true;
    }
    return false;
  }
}
