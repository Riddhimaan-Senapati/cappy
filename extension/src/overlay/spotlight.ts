import { reportExtensionError } from "../extension-context.js";
import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing } from "../../../shared/protocol.js";
import { SUGGESTIONS } from "../defaults.js";
import { ROUTING_LABELS, type AppliedSummary, type UiEvent } from "../messages.js";
import { acceptProposal, forgetLine, rejectProposal } from "../memory.js";
import { deleteRequest, findRequestSessions, load, save, suggestRequests, type StoredState } from "../storage.js";
import { h, icon, type IconName } from "../ui/dom.js";
import { renderSettings, type SettingsContext } from "../ui/settings.js";
import { paintMic, liveRegion, micButton } from "../voice/button.js";
import { VoiceController } from "../voice/controller.js";
import { joinVoiceText, voiceStatusText, type VoiceEvent, type VoiceState } from "../voice/core.js";

export interface SpotlightDeps {
  ask(message: string, fresh: boolean, interrupt?: boolean, thread?: string): void;
  stopRequest(): void;
  listChanges(): ActiveChange[];
  revert(id: string): Promise<void>;
  revertAll(): Promise<void>;
  enableMicrophone(): void;
  openDebug(): void;
  readAloud(): void;
  stopSpeaking(): void;
  isSpeaking(): boolean;
  settings: SettingsContext;
}

type View = "list" | "run" | "settings" | "history";

interface Item {
  id: string;
  icon: IconName;
  title: string;
  hint?: string;
  kind: "ask" | "command" | "undo" | "try" | "previous";
  section: string;
  keywords?: string;
  run(): void | Promise<void>;
}

interface RunResult {
  kind: "done" | "error" | "blocked";
  text: string;
  applied: AppliedSummary[];
}

type MemoryStatus = "proposed" | "remembered" | "rejected" | "forgotten";

interface MemoryEntry {
  line: string;
  status: MemoryStatus;
}

interface RunState {
  runId: string | null;
  message: string;
  steps: Array<{ text: string; tone: string }>;
  memory: MemoryEntry[];
  tier?: { tier: string; model: string };
  result?: RunResult;
  shownSteps: number;
  shownResult: boolean;
}

const AUTO_CLOSE_MS = 9000;
const ROUTING_ORDER: Routing[] = ["auto", "fast", "frontier"];

export class Spotlight {
  private layer = h("div", "sp");
  private scrim = h("div", "scrim");
  private bar = h("div", "bar");
  private orb = h("div", "orb");
  private input = h("input", "input");
  private trail = h("div", "trail");
  private body = h("div", "body");
  private foot = h("div", "foot");
  private view: View = "list";
  private items: Item[] = [];
  private selected = 0;
  private queuedRequests: Array<{ message: string; thread: string }> = [];
  private historyRequest = "";
  private run: RunState | null = null;
  private opened = false;
  private closeTimer: number | undefined;
  private disposeSettings: (() => void) | null = null;
  private animateBody = true;
  private cache: StoredState | null = null;
  private previousFocus: HTMLElement | null = null;
  private idlePlaceholder = 'Try "Make the text bigger"';
  private mic = micButton();
  private live = liveRegion();
  private voiceBase = "";
  private voice = new VoiceController({
    onState: (state) => this.onVoiceState(state),
    onInterim: (text) => this.input.value = joinVoiceText(this.voiceBase, text),
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
    this.input.setAttribute("aria-label", "Ask the agent or search commands");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.body.setAttribute("role", "listbox");

    this.mic.addEventListener("click", () => {
      if (this.voice.active) this.toggleVoice();
      else void this.startVoice().catch(reportExtensionError);
    });
    this.bar.append(h("div", "row", "", [this.orb, this.input, this.mic, this.trail]), this.body, this.foot, this.live);
    this.layer.append(this.scrim, this.bar);
    shadow.append(this.layer);

    this.scrim.addEventListener("click", () => this.hide());
    this.input.addEventListener("input", () => this.onInput());
    this.bar.addEventListener("pointerenter", () => window.clearTimeout(this.closeTimer));
    this.input.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.opened && this.view === "list" && !this.shadow.activeElement) this.input.focus({ preventScroll: true });
      }, 0);
    });
    chrome.storage.onChanged.addListener(() => void this.refreshCache().catch(reportExtensionError));
  }

  isOpen() {
    return this.opened;
  }

  get working() {
    return !!this.run && !this.run.result;
  }

  private async refreshCache() {
    this.cache = await load();
    if (this.opened && this.view === "list") this.renderList();
  }

  toggle() {
    if (this.opened) this.hide();
    else void this.show().catch(reportExtensionError);
  }

  async show(view?: View) {
    this.previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    await this.refreshCache();
    this.opened = true;
    this.input.value = "";
    this.selected = 0;
    this.idlePlaceholder = `Try "${SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)]}"`;
    this.setView(view ?? (this.run && !this.run.result ? "run" : "list"));
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
    this.animateBody = true;
    this.render();
  }

  private render() {
    this.layer.classList.toggle("running", this.view === "run");
    this.input.readOnly = this.view === "settings";
    this.mic.disabled = this.input.readOnly;
    this.input.placeholder = this.view === "settings" ? "Settings" : this.view === "history" ? "Continue this session" : this.view === "run" ? "Refine, or ask for something else" : this.idlePlaceholder;
    this.orb.classList.toggle("work", this.working);
    this.renderTrail();
    if (this.view === "settings") this.renderSettingsView();
    else if (this.view === "run") this.renderRun();
    else if (this.view === "history") this.renderHistory();
    else this.renderList();
    this.renderFoot();
    this.animateBody = false;
  }

  private goHome() {
    window.clearTimeout(this.closeTimer);
    this.historyRequest = "";
    this.setView("list");
    this.input.focus({ preventScroll: true });
  }

  private renderTrail() {
    if (this.view !== "list") {
      const back = h("button", "back", "", [icon("back", 14), document.createTextNode(this.view === "run" ? "Home" : "Back")]);
      back.type = "button";
      back.addEventListener("click", () => this.goHome());
      this.trail.replaceChildren(back);
    } else {
      this.trail.replaceChildren(h("span", "kbd", "esc"));
    }
    if (this.working && (this.view === "run" || this.view === "list")) {
      const stop = h("button", "back", "Stop request");
      stop.type = "button";
      stop.addEventListener("click", () => {
        stop.disabled = true;
        this.deps.stopRequest();
      });
      this.trail.prepend(stop);
    }
  }

  private onInput() {
    window.clearTimeout(this.closeTimer);
    if (this.view === "run" && this.run?.result) this.setView("list");
    if (this.view !== "list") {
      this.renderFoot();
      return;
    }
    this.selected = 0;
    this.renderList();
  }

  private buildItems(): Item[] {
    const q = this.input.value.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (item: Item) => tokens.every((token) => `${item.title} ${item.keywords ?? ""}`.toLowerCase().includes(token));
    const state = this.cache;
    const routing: Routing = state?.routing ?? "auto";
    const changes = this.deps.listChanges();

    const undo: Item[] = changes.map((change) => ({
      id: `undo:${change.id}`,
      icon: "undo",
      title: `Undo: ${change.summary}`,
      hint: change.scope === "everywhere" ? "all sites" : "this site",
      kind: "undo",
      section: "On this page",
      keywords: "revert remove",
      run: () => this.deps.revert(change.id),
    }));

    const next = ROUTING_ORDER[(ROUTING_ORDER.indexOf(routing) + 1) % ROUTING_ORDER.length];
    const cycleModel: Item = {
      id: "model-cycle",
      icon: "bolt",
      title: "Switch model",
      hint: `${ROUTING_LABELS[routing]} → ${ROUTING_LABELS[next]}`,
      kind: "command",
      section: "Commands",
      keywords: "model routing fast frontier auto smart quick",
      run: () => save({ routing: next }),
    };
    const modelChoices: Item[] = ROUTING_ORDER.map((value) => ({
      id: `model:${value}`,
      icon: "bolt",
      title: value === "auto" ? "Model: choose automatically" : `Model: always use ${value}`,
      hint: routing === value ? "current" : undefined,
      kind: "command",
      section: "Commands",
      keywords: "switch change routing fast frontier auto smart quick",
      run: () => save({ routing: value }),
    }));

    const commands: Item[] = [
      { id: "settings", icon: "settings", title: "Settings", hint: "preferences", kind: "command", section: "Commands", keywords: "profile model routing options", run: () => this.setView("settings") },
      cycleModel,
      ...(this.deps.isSpeaking()
        ? [{ id: "stop-reading", icon: "pause" as IconName, title: "Stop reading aloud", hint: "esc", kind: "command" as const, section: "Commands", keywords: "speech tts silence quiet", run: () => (this.deps.stopSpeaking(), this.hide()) }]
        : [{ id: "read-aloud", icon: "volume" as IconName, title: "Read this page aloud", hint: "main text", kind: "command" as const, section: "Commands", keywords: "speech tts speak listen narrate", run: () => (this.deps.readAloud(), this.hide()) }]),
      ...(changes.length
        ? [{ id: "undo-all", icon: "undo" as IconName, title: "Undo all changes on this page", kind: "command" as const, section: "Commands", keywords: "revert reset", run: async () => (await this.deps.revertAll(), this.hide()) }]
        : []),
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
      { id: "debug", icon: "bug", title: "Open debug panel", hint: "chat + tool log", kind: "command", section: "Commands", keywords: "developer console logs", run: () => (this.deps.openDebug(), this.hide()) },
      { id: "clear-chat", icon: "text", title: "Clear chat", hint: "memory is kept", kind: "command", section: "Commands", keywords: "history reset conversation", run: async () => { await save({ history: [], submittedRequests: [], requestSessions: [] }); this.run = null; } },
    ];

    const tries: Item[] = SUGGESTIONS.map((text) => ({ id: `try:${text}`, icon: "sparkle", title: text, kind: "try", section: "Try asking", run: () => this.ask(text, false) }));

    if (!q) return [...undo, ...commands, ...tries];
    const ask: Item = { id: "ask", icon: "sparkle", title: q, hint: "Ask AI", kind: "ask", section: "", run: () => this.ask(q, false) };
    const previous: Item[] = state ? suggestRequests(state, q).map((text) => ({
      id: `previous:${text}`,
      icon: "text",
      title: text,
      hint: "Open request history",
      kind: "previous",
      section: "",
      run: () => this.openHistory(text),
    })) : [];
    const matched = [...undo, ...commands.filter((item) => item.id !== "model-cycle"), ...modelChoices].filter(matches);
    const lowered = q.toLowerCase();
    const strong = q.length >= 2 ? matched.find((item) => item.title.toLowerCase().startsWith(lowered) || item.title.toLowerCase().replace(/^(undo|model): /, "").startsWith(lowered)) : undefined;
    return strong ? [strong, ask, ...previous, ...matched.filter((item) => item !== strong)] : [ask, ...previous, ...matched];
  }

  private renderList() {
    this.items = this.buildItems();
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    const showSections = !this.input.value.trim();
    const nodes: Node[] = [];
    let lastSection = "";
    this.items.forEach((item, index) => {
      if (showSections && item.section !== lastSection) {
        nodes.push(h("div", "sec", item.section));
        lastSection = item.section;
      }
      const row = h("div", `item${index === this.selected ? " sel" : ""}${item.kind === "ask" ? " ask" : ""}`, "", [icon(item.icon, 16), h("span", "title", item.title), item.hint ? h("span", "hint", item.hint) : null]);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.selected));
      row.dataset.index = String(index);
      row.style.setProperty("--i", String(index));
      row.addEventListener("pointermove", () => this.select(index, false));
      row.addEventListener("click", () => void this.runItem(item));
      if (item.kind === "previous") {
        const remove = h("button", "link delete-request", "", [icon("trash")]);
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
      } else {
        nodes.push(row);
      }
    });
    this.body.classList.toggle("enter", this.animateBody);
    this.body.replaceChildren(...nodes);
    this.renderFoot();
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

  private async openHistory(message: string) {
    this.cache = await load();
    if (!this.opened) return;
    this.historyRequest = message;
    this.input.value = "";
    this.setView("history");
    this.input.focus({ preventScroll: true });
  }

  private renderHistory() {
    const sessions = this.cache ? findRequestSessions(this.cache, this.historyRequest) : [];
    const retry = h("button", "link", "Use request again");
    retry.type = "button";
    retry.addEventListener("click", () => {
      this.input.value = this.historyRequest;
      this.setView("list");
      this.input.focus({ preventScroll: true });
    });
    this.body.replaceChildren(
      h("h3", "sec", "Request history"),
      ...sessions.flatMap(({ message, reply, outcome }) => [h("p", "you", message), h("div", `result ${outcome}`, reply || "Done.")]),
      ...(sessions.length ? [] : [h("p", "you", "No reply was saved for this request.")]),
      retry,
    );
  }

  ask(message: string, fresh: boolean, interrupt = false, thread = this.historyRequest) {
    if (!message || (this.working && !interrupt)) return;
    window.clearTimeout(this.closeTimer);
    this.run = { runId: null, message, steps: [{ text: "Sending to the agent", tone: "info" }], memory: [], shownSteps: 0, shownResult: false };
    this.input.value = "";
    this.setView("run");
    this.historyRequest = thread;
    this.deps.ask(message, fresh, interrupt, thread || undefined);
  }

  private queueRequest() {
    const message = this.input.value.trim();
    if (!message) return;
    if (!this.working) {
      this.ask(message, false);
      return;
    }
    this.queuedRequests.push({ message, thread: this.historyRequest });
    this.input.value = "";
    this.onInput();
    this.input.focus({ preventScroll: true });
    this.live.textContent = "Request queued for later.";
  }

  private queueControls(): Node[] {
    const button = (label: string, action: () => void, disabled = false) => {
      const control = h("button", "link", label);
      control.type = "button";
      control.disabled = disabled;
      control.addEventListener("click", action);
      return control;
    };
    const message = this.input.value.trim();
    const controls: Node[] = [];
    if (message) {
      controls.push(h("div", "queue-actions", "", [
        button("Send now", () => this.ask(this.input.value.trim(), false, true)),
        h("span", "hint", "Ctrl/⌘ + Enter"),
        button("Queue for later", () => this.queueRequest()),
        h("span", "hint", "Alt/Option + Enter"),
      ]));
    }
    if (this.queuedRequests.length) {
      const rows = this.queuedRequests.map((request, index) => h("div", "queue-actions", "", [
        h("span", "queue-text", request.message),
        button("Send now", () => {
          this.queuedRequests.splice(index, 1);
          const draft = this.input.value;
          this.ask(request.message, false, true, request.thread);
          this.input.value = draft;
          this.renderFoot();
        }),
        button("Remove", () => {
          this.queuedRequests.splice(index, 1);
          this.renderFoot();
          this.input.focus({ preventScroll: true });
        }),
      ]));
      controls.push(h("details", "request-queue", "", [h("summary", "", `Queued requests (${rows.length})`), ...rows]));
    }
    return controls;
  }

  private renderRun() {
    const run = this.run;
    if (!run) return;
    this.body.classList.remove("enter");
    const visible = run.steps.slice(-5);
    const stepNodes = visible.map((step, i) => h("li", `step ${step.tone}${run.steps.length - visible.length + i >= run.shownSteps ? " new" : ""}`, step.text));
    run.shownSteps = run.steps.length;

    const children: Node[] = [h("div", "you", "", [icon("sparkle", 15), h("span", "", run.message)])];
    if (stepNodes.length) children.push(h("ul", `steps${run.result ? "" : " live"}`, "", stepNodes));
    if (run.memory.length) children.push(h("div", "applied", "", run.memory.map((entry) => this.memoryCard(entry))));

    if (run.result) {
      const { kind, text, applied } = run.result;
      children.push(h("div", `result ${kind === "done" ? "" : kind}${run.shownResult ? "" : " new"}`, "", [icon(kind === "done" ? "check" : kind === "blocked" ? "shield" : "x", 15), h("p", "", text)]));
      run.shownResult = true;
      if (applied.length) {
        const cards = applied.map((change) => {
          const undo = h("button", "link", "Undo");
          undo.type = "button";
          const card = h("div", "chg", "", [
            h("div", "top", "", [h("b", "", change.summary), h("span", "tag", change.scope === "everywhere" ? "all sites" : "this site"), undo]),
            h("div", "why", `Because: ${change.reason}`),
          ]);
          undo.addEventListener("click", async () => {
            await this.deps.revert(change.id);
            card.classList.add("gone");
            undo.remove();
          });
          return card;
        });
        children.push(h("div", "applied", "", cards));
      }
    }
    this.body.replaceChildren(h("div", "run", "", children));
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
    const actions = entry.status === "proposed"
      ? [act("Accept", "remembered", acceptProposal), act("Reject", "rejected", rejectProposal)]
      : entry.status === "remembered"
        ? [act("Undo", "forgotten", forgetLine)]
        : [];
    const label = { proposed: "Remember this?", remembered: "Remembered", rejected: "Not remembered", forgotten: "Forgotten" }[entry.status];
    const inactive = entry.status === "rejected" || entry.status === "forgotten";
    return h("div", `chg${inactive ? " gone" : ""}`, "", [h("div", "top", "", [h("b", "", entry.line), h("span", "tag", label), ...actions])]);
  }

  private renderSettingsView() {
    this.disposeSettings?.();
    const container = h("div", "settings");
    this.body.classList.remove("enter");
    this.body.replaceChildren(container);
    this.disposeSettings = renderSettings(container, this.deps.settings);
  }

  private renderFoot() {
    const hint = (keys: string[], label: string) => h("span", "k", "", [...keys.map((key) => h("span", "kbd", key)), h("span", "", label)]);
    const left =
      this.view === "settings"
        ? [hint(["esc"], "back")]
        : this.view === "run"
          ? [hint(["↵"], "send a follow-up"), hint(["esc"], "home")]
          : [hint(["↑", "↓"], "navigate"), hint(["↵"], "select"), ...(this.input.value.trim() ? [hint(["⇧", "↵"], "ask AI again")] : [])];
    const nodes: Node[] = [...left, h("span", "grow")];
    if (this.run?.tier && this.view === "run") nodes.push(h("span", `chip ${this.run.tier.tier}`, `${this.run.tier.tier} · ${this.run.tier.model}`));
    const queueWasOpen = this.foot.querySelector("details")?.open;
    const shortcuts = h("div", "queue-actions", "", nodes);
    this.foot.replaceChildren(shortcuts, ...(this.input.readOnly ? [] : this.queueControls()));
    const queue = this.foot.querySelector("details");
    if (queue) queue.open = queueWasOpen ?? true;
  }

  handleEvent(event: UiEvent): boolean {
    const run = this.run;
    if (!run) return false;
    if (event.type === "start") {
      if (run.runId === null && event.trigger === "chat" && event.message === run.message) {
        run.runId = event.runId;
        run.steps = [];
        return true;
      }
      return false;
    }
    if (run.runId !== event.runId) return false;

    switch (event.type) {
      case "step":
        run.steps.push({ text: event.text, tone: event.tone });
        break;
      case "tier":
        run.tier = { tier: event.tier, model: event.model };
        break;
      case "memory":
        run.memory.push(...event.lines.map((line) => ({ line, status: (event.status === "saved" ? "remembered" : "proposed") as MemoryStatus })));
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
    }
    if (event.type === "done" && this.queuedRequests.length) {
      const next = this.queuedRequests.shift()!;
      const draft = this.input.value;
      this.ask(next.message, false, false, next.thread);
      this.input.value = draft;
      if (this.opened) this.renderFoot();
      return true;
    }
    if (this.opened) {
      this.render();
      if (run.result) {
        this.input.focus({ preventScroll: true });
        window.clearTimeout(this.closeTimer);
        this.closeTimer = window.setTimeout(() => {
          if (this.opened && this.view === "run" && !this.input.value && !this.bar.matches(":hover")) this.hide();
        }, AUTO_CLOSE_MS);
      }
    } else {
      this.orb.classList.toggle("work", this.working);
    }
    return true;
  }

  async startVoice() {
    if (!this.opened) await this.show();
    if (this.view === "settings" || this.view === "history") this.setView("list");
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
    if (text && (this.cache?.voiceAutoSend ?? true)) {
      this.input.value = "";
      if (this.working) {
        this.input.value = value;
        this.queueRequest();
      } else this.ask(value, false);
      return;
    }
    this.input.focus({ preventScroll: true });
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.opened || event.isComposing) return false;
    const { key } = event;
    if (event.altKey && event.code === "KeyM" && this.view !== "settings") {
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
    if (!this.input.readOnly && key === "Enter" && (event.metaKey || event.ctrlKey)) {
      this.ask(this.input.value.trim(), false, true);
      return true;
    }
    if (!this.input.readOnly && key === "Enter" && (event.altKey || (this.working && this.input.value.trim()))) {
      this.queueRequest();
      return true;
    }
    if (this.view === "list" && this.items.length) {
      if (key === "ArrowDown" || (key === "Tab" && !event.shiftKey)) return this.select((this.selected + 1) % this.items.length), true;
      if (key === "ArrowUp" || (key === "Tab" && event.shiftKey)) return this.select((this.selected - 1 + this.items.length) % this.items.length), true;
      const selected = this.items[this.selected];
      if (key === "Delete" && event.shiftKey && selected?.kind === "previous") {
        void this.deleteSuggestion(selected.title);
        return true;
      }
      if (key === "Enter") {
        const item = selected;
        if (event.shiftKey && item.kind === "ask") this.ask(this.input.value.trim(), true);
        else void this.runItem(item);
        return true;
      }
    }
    if ((this.view === "run" || this.view === "history") && key === "Enter") {
      const text = this.input.value.trim();
      if (text) this.ask(text, event.shiftKey);
      else this.hide();
      return true;
    }
    return false;
  }
}
