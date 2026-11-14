import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing, TargetElement } from "../../../shared/protocol.js";
import { ROUTING_LABELS, type AppliedSummary, type StatusInfo, type UiEvent } from "../messages.js";
import { load, save, type SavedCommand, type StoredState } from "../storage.js";
import { h, icon, type IconName } from "../ui/dom.js";
import { renderSettings, type SettingsContext } from "../ui/settings.js";

export interface SpotlightDeps {
  ask(message: string, fresh: boolean, target?: TargetElement): void;
  clearTarget(): void;
  pick(): void;
  listChanges(): ActiveChange[];
  history(): Array<{ change: ActiveChange; active: boolean }>;
  reapply(change: ActiveChange): Promise<void>;
  revert(id: string): Promise<void>;
  revertAll(): Promise<void>;
  openDebug(): void;
  settings: SettingsContext;
  ensureAlive(): boolean;
  stop(): void;
  dequeue(runId: string): void;
  suggest(): Promise<string | null>;
}

type View = "list" | "run" | "settings" | "history" | "commands";

interface Item {
  id: string;
  icon: IconName;
  title: string;
  hint?: string;
  kind: "ask" | "command" | "undo" | "try" | "saved";
  section: string;
  keywords?: string;
  run(): void | Promise<void>;
}

interface Step {
  text: string;
  tone: "info" | "good" | "warn" | "bad";
}

interface RunState {
  runId: string | null;
  message: string;
  target?: string;
  status: "pending" | "queued" | "running" | "done";
  steps: Step[];
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
  undone: boolean;
}

const MAX_THREAD = 6;
const AUTO_CLOSE_MS = 9000;
const SUGGESTION_COUNT = 3;

export class Spotlight {
  private layer = h("div", "sp");
  private scrim = h("div", "scrim");
  private bar = h("div", "bar");
  private orb = h("div", "orb");
  private input = h("input", "input");
  private pill = h("button", "pill");
  private pickButton = h("button", "pick");
  private chip = h("div", "target-chip");
  private target: TargetElement | null = null;
  private body = h("div", "body");
  private hints = h("div", "hints");
  private view: View = "list";
  private items: Item[] = [];
  private selected = 0;
  private runs: RunState[] = [];
  private opened = false;
  private closeTimer: number | undefined;
  private disposeSettings: (() => void) | null = null;
  private animateBody = true;
  private cache: StoredState | null = null;
  private status: StatusInfo | null = null;
  private previousFocus: HTMLElement | null = null;
  private placeholder = "Ask anything  ·  / for commands";

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

    this.chip.hidden = true;
    this.pickButton.type = "button";
    this.pickButton.title = "Choose an element on the page";
    this.pickButton.setAttribute("aria-label", "Choose an element on the page");
    this.pickButton.append(icon("target", 15));
    this.pickButton.addEventListener("click", () => this.startPicking());
    this.bar.append(h("div", "row", "", [this.orb, this.chip, this.input, this.pickButton, this.pill]), this.body, this.hints);
    this.layer.append(this.scrim, this.bar);
    shadow.append(this.layer);

    this.scrim.addEventListener("click", () => this.hide());
    this.input.addEventListener("input", () => this.onInput());
    this.pill.addEventListener("click", () => (this.view === "settings" || this.view === "history" || this.view === "commands" ? this.setView("list") : void this.toggleModel()));
    this.bar.addEventListener("pointerenter", () => window.clearTimeout(this.closeTimer));
    this.input.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.opened && this.view === "list" && !this.shadow.activeElement) this.input.focus({ preventScroll: true });
      }, 0);
    });
    chrome.storage.onChanged.addListener(() => void this.refreshCache());
    addEventListener("pointerdown", this.onOutsidePointer, true);
  }

  private onOutsidePointer = (event: PointerEvent) => {
    if (this.opened && !event.composedPath().includes(this.shadow.host)) this.hide();
  };

  destroy() {
    removeEventListener("pointerdown", this.onOutsidePointer, true);
    window.clearTimeout(this.closeTimer);
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
    else void this.show();
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
    this.smartSuggestion = null;
    void this.deps.suggest().then((text) => {
      this.smartSuggestion = text;
      if (text && this.opened && this.view === "list" && !this.input.value) {
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

  private startPicking() {
    this.hide();
    this.deps.pick();
  }

  showWithTarget(target: TargetElement) {
    this.setTarget(target);
    if (this.opened) {
      this.setView("list");
      this.input.focus({ preventScroll: true });
    } else void this.show("list");
  }

  private setTarget(target: TargetElement | null) {
    this.target = target;
    this.chip.hidden = !target;
    if (!target) {
      this.deps.clearTarget();
      this.chip.replaceChildren();
      return;
    }
    const remove = h("button", "chip-x", "", [icon("x", 11)]);
    remove.type = "button";
    remove.setAttribute("aria-label", "Clear the selected element");
    remove.addEventListener("click", () => {
      this.setTarget(null);
      this.render();
      this.input.focus({ preventScroll: true });
    });
    this.chip.replaceChildren(icon("target", 12), h("span", "", target.label), remove);
    this.chip.title = `Selected: ${target.label}`;
  }

  hide() {
    if (!this.opened) return;
    if (this.target) this.setTarget(null);
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
    if (view === "settings" || view === "history" || view === "commands") this.input.value = "";
    if (view === "commands") this.commandSelected = 0;
    if (view === "history") this.historySelected = 0;
    this.animateBody = true;
    this.render();
  }

  private render() {
    this.layer.classList.toggle("running", this.view === "run");
    this.input.readOnly = this.view === "settings" || this.view === "history" || this.view === "commands";
    this.input.placeholder =
      this.view === "settings" ? "Settings" : this.view === "history" ? "Changes on this page  ·  Space to turn on or off" : this.view === "commands" ? "Saved commands  ·  Enter to run  ·  Space for every site" : this.target ? "What should change about this?" : this.view === "run" ? (this.working ? "Add another request" : "Ask a follow-up") : this.placeholder;
    this.orb.classList.toggle("work", this.working);
    this.pickButton.hidden = this.view !== "list" && this.view !== "run";
    this.renderPill();
    if (this.view === "settings") this.renderSettingsView();
    else if (this.view === "history") this.renderHistory();
    else if (this.view === "commands") this.renderCommands();
    else if (this.view === "run") this.renderRun();
    else this.renderList();
    this.renderHints();
    this.animateBody = false;
  }

  private renderPill() {
    if (this.view === "settings" || this.view === "history" || this.view === "commands") {
      this.pill.className = "pill";
      this.pill.replaceChildren(icon("back", 13), document.createTextNode("Back"));
      this.pill.title = "Back (Esc)";
      this.pill.setAttribute("aria-label", "Back");
      return;
    }
    const routing: Routing = this.cache?.routing ?? "fast";
    const models = this.status?.models;
    this.pill.className = `pill${routing === "frontier" ? " pro" : ""}`;
    this.pill.replaceChildren(icon(routing === "frontier" ? "sparkle" : "bolt", 13), document.createTextNode(ROUTING_LABELS[routing]), h("span", "k", "⇥"));
    const detail = models ? ` (Fast: ${models.fast}, Pro: ${models.frontier})` : "";
    this.pill.title = `Model: ${ROUTING_LABELS[routing]}. Tab to switch${detail}`;
    this.pill.setAttribute("aria-label", `Model ${ROUTING_LABELS[routing]}, press Tab to switch`);
  }

  private async toggleModel() {
    const routing: Routing = this.cache?.routing ?? "fast";
    const next: Routing = routing === "frontier" ? "fast" : "frontier";
    if (this.cache) this.cache.routing = next;
    this.renderPill();
    this.pill.classList.remove("flip");
    void this.pill.offsetWidth;
    this.pill.classList.add("flip");
    await save({ routing: next });
  }

  private renderHints() {
    this.hints.hidden = true;
  }

  private smartSuggestion: string | null = null;

  private suggestion(): Item | null {
    const text = this.smartSuggestion;
    if (!text) return null;
    return { id: `try:${text}`, icon: "sparkle", title: text, hint: "suggested", kind: "try", section: "", run: () => this.ask(text, false) };
  }

  private onInput() {
    window.clearTimeout(this.closeTimer);
    if (this.view === "run" && !this.working) this.setView("list");
    if (this.view !== "list") return;
    this.selected = 0;
    this.renderList();
    this.renderHints();
  }

  private commands(changes: ActiveChange[]): Item[] {
    const state = this.cache;
    return [
      { id: "pick", icon: "target", title: "Select an element on the page", hint: "then say what to change", kind: "command", section: "Commands", keywords: "pick choose this element point target inspect", run: () => this.startPicking() },
      { id: "commands", icon: "bookmark", title: "Saved commands", hint: "→", kind: "command", section: "Commands", keywords: "shortcuts presets saved favorites", run: () => this.setView("commands") },
      {
        id: "camera",
        icon: "eye",
        title: state?.camera.enabled ? "Turn off camera control" : "Turn on camera control",
        hint: "gestures",
        kind: "command",
        section: "Commands",
        keywords: "camera gestures hands head pointer webcam mediapipe",
        run: async () => {
          const current = (await load()).camera;
          await save({ camera: { ...current, enabled: !current.enabled } });
          this.hide();
        },
      },
      { id: "history", icon: "history", title: "Change history", hint: "→", kind: "command", section: "Commands", keywords: "changes log toggle before after compare", run: () => this.setView("history") },
      { id: "settings", icon: "settings", title: "Settings", kind: "command", section: "Commands", keywords: "preferences profile model options", run: () => this.setView("settings") },
      ...(changes.length ? [{ id: "undo-all", icon: "undo" as IconName, title: "Undo all changes on this page", kind: "command" as const, section: "Commands", keywords: "revert reset", run: async () => (await this.deps.revertAll(), this.hide()) }] : []),
      {
        id: "pause",
        icon: state?.paused ? "play" : "pause",
        title: state?.paused ? "Resume adaptations" : "Pause adaptations",
        kind: "command",
        section: "Commands",
        keywords: "kill switch off on disable enable",
        run: async () => (await save({ paused: !state?.paused }), this.hide()),
      },
      {
        id: "fab",
        icon: "circle",
        title: state?.floatingButton === false ? "Show floating button" : "Hide floating button",
        kind: "command",
        section: "Commands",
        keywords: "orb launcher",
        run: async () => (await save({ floatingButton: state?.floatingButton === false }), this.hide()),
      },
      { id: "model", icon: "bolt", title: "Switch model", hint: (state?.routing ?? "fast") === "frontier" ? "Pro → Fast" : "Fast → Pro", kind: "command", section: "Commands", keywords: "fast pro smart frontier routing", run: () => this.toggleModel() },
      { id: "debug", icon: "bug", title: "Open debug panel", kind: "command", section: "Commands", keywords: "developer console logs chat", run: () => (this.deps.openDebug(), this.hide()) },
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

    if (!raw && this.target) return [];
    if (!raw) {
      const last = [...changes].sort((a, b) => b.appliedAt - a.appliedAt)[0];
      const items: Item[] = [];
      if (last) items.push({ id: "undo-last", icon: "undo", title: `Undo ${last.summary.charAt(0).toLowerCase()}${last.summary.slice(1)}`, hint: "→ history", kind: "undo", section: "", run: () => this.deps.revert(last.id) });
      const suggestion = this.suggestion();
      if (suggestion) items.push(suggestion);
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

    const matched = pool.filter(matches);
    const ask: Item = { id: "ask", icon: "sparkle", title: raw, hint: "Ask", kind: "ask", section: "", run: () => this.ask(raw, false) };
    const strong = query.length >= 2 ? matched.find((item) => item.title.toLowerCase().startsWith(query)) : undefined;
    return (strong ? [strong, ask, ...matched.filter((item) => item !== strong)] : [ask, ...matched]).slice(0, 5);
  }

  private renderList() {
    this.items = this.buildItems();
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    const showSections = false;
    const nodes: Node[] = [];
    let lastSection = "";
    this.items.forEach((item, index) => {
      if (showSections && item.section !== lastSection) {
        nodes.push(h("div", "sec", item.section));
        lastSection = item.section;
      }
      const row = h("div", `item${index === this.selected ? " sel" : ""}`, "", [icon(item.icon, 15), h("span", "title", item.title), item.hint ? h("span", "hint", item.hint) : null]);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === this.selected));
      row.dataset.index = String(index);
      row.style.setProperty("--i", String(index));
      row.addEventListener("pointermove", () => this.select(index, false));
      row.addEventListener("click", () => void this.runItem(item));
      nodes.push(row);
    });
    this.body.classList.toggle("enter", this.animateBody);
    this.body.replaceChildren(...nodes);
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

  ask(message: string, fresh: boolean) {
    if (!message) return;
    window.clearTimeout(this.closeTimer);
    for (const run of this.runs) if (run.status === "done") run.open = false;
    const target = this.target ?? undefined;
    this.runs.push({ runId: null, message, target: target?.label, status: "pending", steps: [{ text: "Reading the page", tone: "info" }], startedAt: Date.now(), open: true, expanded: false, shownSteps: 0, shownResult: false, seen: false, saving: false, undone: false });
    while (this.runs.length > MAX_THREAD) {
      const oldest = this.runs.findIndex((run) => run.status === "done");
      if (oldest < 0) break;
      this.runs.splice(oldest, 1);
    }
    this.input.value = "";
    if (target) {
      this.target = null;
      this.chip.hidden = true;
      this.chip.replaceChildren();
    }
    this.setView("run");
    this.deps.ask(message, fresh, target);
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

    if (run.status === "queued" || (run.status === "pending" && busy)) {
      const remove = h("button", "x", "", [icon("x", 12)]);
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove "${run.message}" from the queue`);
      remove.addEventListener("click", () => {
        if (run.runId) this.deps.dequeue(run.runId);
        this.runs = this.runs.filter((other) => other !== run);
        this.renderRun();
      });
      return h("div", `card queued${enter}`, "", [h("span", "next", "Next"), h("span", "q", run.message), remove]);
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
    const head = h("div", "ask-line", "", [h("span", "q", run.target ? `${run.message} (${run.target})` : run.message)]);
    if (live) {
      const stop = h("button", "link stop", "Stop");
      stop.type = "button";
      stop.addEventListener("click", () => this.deps.stop());
      head.append(h("span", "meta", `${this.elapsed(run)}${run.model ? ` · ${run.model}` : ""}`), stop);
      return h("div", `card active${enter}`, "", [head, h("ul", "steps", "", this.stepNodes(run, true))]);
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
    const resultRow = h("div", `result ${kind === "done" ? "" : kind}${run.shownResult ? "" : " new"}${run.undone ? " undone" : ""}`, "", [icon(run.undone ? "undo" : kind === "done" ? "check" : kind === "blocked" ? "shield" : "x", 15), h("span", "", run.undone ? "Undone. The page is back to how it was before this request." : text)]);
    if (kind === "done" && applied.length && !run.undone) {
      const undoAll = h("button", "undo-all", "", [icon("undo", 13), document.createTextNode(applied.length > 1 ? " Undo all" : " Undo")]);
      undoAll.type = "button";
      undoAll.title = "Undo everything this request changed (Ctrl+Z)";
      undoAll.addEventListener("click", () => void this.undoRun(run));
      resultRow.append(undoAll);
    }
    const children: Node[] = [head, resultRow];
    run.shownResult = true;
    if (applied.length && !run.undone) {
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
            row.title = `Because: ${change.reason}`;
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
    if (kind === "done" && applied.length && !run.undone && run === this.latestUndoable()) footer.append(h("span", "fold hint-z", "Ctrl+Z to undo"));
    const alreadySaved = (this.cache?.commands ?? []).some((command) => command.prompt.toLowerCase() === run.message.toLowerCase());
    if (kind === "done" && applied.length && !alreadySaved && !run.saving && !run.undone) {
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

  private latestUndoable(): RunState | undefined {
    return [...this.runs].reverse().find((run) => run.status === "done" && !run.undone && run.result?.kind === "done" && run.result.applied.length > 0);
  }

  private async undoRun(run: RunState) {
    if (!run.result || run.undone) return;
    for (const change of run.result.applied) await this.deps.revert(change.id);
    run.undone = true;
    run.open = true;
    if (this.view === "run") this.renderRun();
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
        case "blocked":
          run.result = { kind: "blocked", text: "Blocked. This page tried to give the agent instructions.", applied: [] };
          break;
        case "done":
          if (!run.result) run.result = { kind: "done", text: event.reply || "Done.", applied: event.applied };
          break;
        case "error":
          run.result = { kind: "error", text: event.message, applied: [] };
          break;
        case "cancelled":
          if (run.status === "queued" || run.status === "pending") this.runs = this.runs.filter((other) => other !== run);
          else run.result = { kind: "error", text: "Stopped.", applied: [] };
          break;
      }
      if (run.result && run.status !== "done") {
        run.status = "done";
        run.endedAt = Date.now();
        // The outline marks what the agent is working on; clear it once that request is finished.
        if (run.target && !this.target) this.deps.clearTarget();
      }
    }

    if (!this.opened) {
      this.orb.classList.toggle("work", this.working);
      return true;
    }
    if (this.view === "run") this.render();
    else this.orb.classList.toggle("work", this.working);
    if (!this.working && run.status === "done") {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = window.setTimeout(() => {
        if (this.opened && this.view === "run" && !this.working && !this.input.value && !this.bar.matches(":hover") && !this.runs.some((other) => other.expanded)) this.hide();
      }, AUTO_CLOSE_MS);
    }
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.opened || event.isComposing) return false;
    const { key } = event;
    const focused = this.shadow.activeElement;
    // Buttons and fields inside the bar handle their own keys (Enter on Undo, typing a command name); only Escape still closes.
    if (focused && focused !== this.input && key !== "Escape") return false;
    if (key === "Escape") {
      if (this.view === "settings" || this.view === "history" || this.view === "commands") this.setView("list");
      else this.hide();
      return true;
    }
    const inSearchField = this.shadow.activeElement === this.input;
    // Focus sits in the search field, outside the scrollable panel, so scroll keys would otherwise scroll the page behind.
    if ((this.view === "settings" || this.view === "run") && inSearchField && !this.input.value) {
      const step: Record<string, number> = { ArrowDown: 56, ArrowUp: -56, PageDown: this.body.clientHeight * 0.85, PageUp: -this.body.clientHeight * 0.85 };
      if (key in step) return this.body.scrollBy({ top: step[key], behavior: "smooth" }), true;
      if (key === "Home" || key === "End") return this.body.scrollTo({ top: key === "Home" ? 0 : this.body.scrollHeight, behavior: "smooth" }), true;
    }
    if (this.view === "history") {
      if (key === "ArrowDown") return this.moveHistory(1), true;
      if (key === "ArrowUp") return this.moveHistory(-1), true;
      if (key === " " || key === "Enter") return void this.toggleHistory(this.historySelected), true;
      if (key === "Backspace" || key === "ArrowLeft") return this.setView("list"), true;
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
      if (key === "Backspace" || key === "ArrowLeft") return this.setView("list"), true;
    }
    if (this.view === "run" && inSearchField && !this.input.value && (event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
      const run = this.latestUndoable();
      if (run) void this.undoRun(run);
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
    if (key === "Backspace" && inSearchField && !this.input.value && (this.view === "settings" || (this.view === "run" && !this.working))) {
      this.setView("list");
      return true;
    }
    // Tab switches the model only while typing; otherwise it moves focus so keyboard users can reach Undo and Save.
    const typing = inSearchField && (this.input.value.length > 0 || this.view === "list");
    if (key === "Tab" && typing && this.view !== "settings" && this.view !== "history" && this.view !== "commands") {
      void this.toggleModel();
      this.renderHints();
      return true;
    }
    if (this.view === "list" && this.items.length) {
      if (key === "ArrowDown") return this.select((this.selected + 1) % this.items.length), true;
      if (key === "ArrowUp") return this.select((this.selected - 1 + this.items.length) % this.items.length), true;
      if (key === "Enter") {
        const item = this.items[this.selected];
        if (event.shiftKey && item.kind === "ask") this.ask(this.input.value.trim(), true);
        else void this.runItem(item);
        return true;
      }
    }
    if (this.view === "run" && key === "Enter") {
      const text = this.input.value.trim();
      if (text) this.ask(text, event.shiftKey);
      else this.hide();
      return true;
    }
    return false;
  }
}
