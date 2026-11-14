import type { ActiveChange } from "../../../shared/adaptation.js";
import type { Routing } from "../../../shared/protocol.js";
import { SUGGESTIONS } from "../defaults.js";
import { ROUTING_LABELS, type AppliedSummary, type StatusInfo, type UiEvent } from "../messages.js";
import { load, save, type StoredState } from "../storage.js";
import { h, icon, type IconName } from "../ui/dom.js";
import { renderSettings, type SettingsContext } from "../ui/settings.js";

export interface SpotlightDeps {
  ask(message: string, fresh: boolean): void;
  listChanges(): ActiveChange[];
  revert(id: string): Promise<void>;
  revertAll(): Promise<void>;
  openDebug(): void;
  settings: SettingsContext;
  ensureAlive(): boolean;
}

type View = "list" | "run" | "settings";

interface Item {
  id: string;
  icon: IconName;
  title: string;
  hint?: string;
  kind: "ask" | "command" | "undo" | "try";
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
  steps: Step[];
  model?: string;
  tier?: string;
  startedAt: number;
  endedAt?: number;
  result?: { kind: "done" | "error" | "blocked"; text: string; applied: AppliedSummary[] };
  shownResult: boolean;
  shownSteps: number;
  expanded: boolean;
}

const AUTO_CLOSE_MS = 9000;
const SUGGESTION_COUNT = 3;

export class Spotlight {
  private layer = h("div", "sp");
  private scrim = h("div", "scrim");
  private bar = h("div", "bar");
  private orb = h("div", "orb");
  private input = h("input", "input");
  private pill = h("button", "pill");
  private body = h("div", "body");
  private hints = h("div", "hints");
  private view: View = "list";
  private items: Item[] = [];
  private selected = 0;
  private run: RunState | null = null;
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

    this.bar.append(h("div", "row", "", [this.orb, this.input, this.pill]), this.body, this.hints);
    this.layer.append(this.scrim, this.bar);
    shadow.append(this.layer);

    this.scrim.addEventListener("click", () => this.hide());
    this.input.addEventListener("input", () => this.onInput());
    this.pill.addEventListener("click", () => (this.view === "settings" ? this.setView("list") : void this.toggleModel()));
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
    return !!this.run && !this.run.result;
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
    this.suggestionSeed = Math.random();
    this.input.value = "";
    this.selected = 0;
    this.setView(view ?? (this.working ? "run" : "list"));
    this.layer.classList.add("open");
    this.onToggle(true);
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  hide() {
    if (!this.opened) return;
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
    if (view === "settings") this.input.value = "";
    this.animateBody = true;
    this.render();
  }

  private render() {
    this.layer.classList.toggle("running", this.view === "run");
    this.input.readOnly = this.view === "settings";
    this.input.placeholder = this.view === "settings" ? "Settings" : this.view === "run" ? "Ask a follow-up" : this.placeholder;
    this.orb.classList.toggle("work", this.working);
    this.renderPill();
    if (this.view === "settings") this.renderSettingsView();
    else if (this.view === "run") this.renderRun();
    else this.renderList();
    this.renderHints();
    this.animateBody = false;
  }

  private renderPill() {
    if (this.view === "settings") {
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

  private suggestion(changes: ActiveChange[]): Item | null {
    const open = SUGGESTIONS.filter((candidate) => !changes.some((change) => candidate.covers.test(`${change.summary} ${change.id}`)));
    if (!open.length) return null;
    const pick = open[Math.floor(this.suggestionSeed * open.length)];
    return { id: `try:${pick.text}`, icon: "sparkle", title: pick.text, hint: "suggested", kind: "try", section: "", run: () => this.ask(pick.text, false) };
  }

  private suggestionSeed = Math.random();

  private onInput() {
    window.clearTimeout(this.closeTimer);
    if (this.view === "run" && this.run?.result) this.setView("list");
    if (this.view !== "list") return;
    this.selected = 0;
    this.renderList();
    this.renderHints();
  }

  private commands(changes: ActiveChange[]): Item[] {
    const state = this.cache;
    return [
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

    if (!raw) {
      const suggestion = this.suggestion(changes);
      return suggestion ? [suggestion] : [];
    }

    const isCommand = raw.startsWith("/");
    const query = (isCommand ? raw.slice(1) : raw).trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = (item: Item) => tokens.every((token) => `${item.title} ${item.keywords ?? ""}`.toLowerCase().includes(token));
    const pool = [...undo, ...this.commands(changes)];
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
    this.run = { runId: null, message, steps: [{ text: "Reading the page", tone: "info" }], startedAt: Date.now(), shownResult: false, shownSteps: 0, expanded: false };
    this.input.value = "";
    this.setView("run");
    this.deps.ask(message, fresh);
  }

  private elapsed(run: RunState) {
    return `${(((run.endedAt ?? Date.now()) - run.startedAt) / 1000).toFixed(1)}s`;
  }

  private stepNodes(run: RunState, live: boolean): Node[] {
    const currentTask = live ? run.steps.map((step) => step.tone).lastIndexOf("info") : -1;
    const nodes = run.steps.map((step, index) => {
      const isOutcome = step.tone !== "info";
      const current = index === currentTask;
      const mark = current ? h("span", "spin") : icon(step.tone === "bad" ? "x" : step.tone === "warn" ? "circle" : "check", 12);
      const row = h("li", `st ${step.tone}${isOutcome ? " out" : ""}${current ? " now" : ""}${index >= run.shownSteps ? " new" : ""}`, "", [mark, h("span", "t", step.text)]);
      return row;
    });
    run.shownSteps = run.steps.length;
    return live ? nodes.slice(-6) : nodes;
  }

  private renderRun() {
    const run = this.run;
    if (!run) return;
    this.body.classList.remove("enter");
    const meta = h("span", "meta", `${this.elapsed(run)}${run.model ? ` · ${run.model}` : ""}`);
    const head = h("div", "ask-line", "", [h("span", "q", run.message), meta]);

    if (!run.result) {
      this.body.replaceChildren(h("div", "run", "", [head, h("ul", "steps", "", this.stepNodes(run, true))]));
      this.startTicker();
      return;
    }

    this.stopTicker();
    const { kind, text, applied } = run.result;
    const result = h("div", `result ${kind === "done" ? "" : kind}${run.shownResult ? "" : " new"}`, "", [icon(kind === "done" ? "check" : kind === "blocked" ? "shield" : "x", 15), h("span", "", text)]);
    run.shownResult = true;
    const children: Node[] = [head, result];
    if (applied.length) {
      const rows = applied.map((change) => {
        const undo = h("button", "link", "Undo");
        undo.type = "button";
        const row = h("div", "chg", "", [h("b", "", change.summary), h("span", "why", change.reason), undo]);
        row.title = `Because: ${change.reason}`;
        undo.setAttribute("aria-label", `Undo ${change.summary}`);
        undo.addEventListener("click", async () => {
          await this.deps.revert(change.id);
          row.classList.add("gone");
          undo.remove();
        });
        return row;
      });
      children.push(h("div", "changes", "", rows));
    }

    const count = run.steps.filter((step) => step.tone === "info").length;
    const toggle = h("button", "fold", `${run.expanded ? "Hide" : "Show"} ${count} step${count === 1 ? "" : "s"} · ${this.elapsed(run)}${run.model ? ` · ${run.model}` : ""}`);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(run.expanded));
    toggle.addEventListener("click", () => {
      run.expanded = !run.expanded;
      run.shownSteps = run.expanded ? 0 : run.steps.length;
      this.renderRun();
    });
    children.push(toggle);
    if (run.expanded) children.push(h("ul", "steps done", "", this.stepNodes(run, false)));
    head.lastElementChild?.remove();
    this.body.replaceChildren(h("div", "run", "", children));
  }

  private ticker: number | undefined;

  private startTicker() {
    if (this.ticker !== undefined) return;
    this.ticker = window.setInterval(() => {
      const meta = this.body.querySelector<HTMLElement>(".meta");
      if (!this.run || this.run.result || !meta) return this.stopTicker();
      meta.textContent = `${this.elapsed(this.run)}${this.run.model ? ` · ${this.run.model}` : ""}`;
    }, 100);
  }

  private stopTicker() {
    window.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private renderSettingsView() {
    this.disposeSettings?.();
    const container = h("div", "settings");
    this.body.classList.remove("enter");
    this.body.replaceChildren(container);
    this.disposeSettings = renderSettings(container, this.deps.settings);
  }

  handleEvent(event: UiEvent): boolean {
    const run = this.run;
    if (!run) return false;
    if (event.type === "start") {
      if (run.runId === null && event.trigger === "chat" && event.message === run.message) {
        run.runId = event.runId;
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
    }
    if (run.result && !run.endedAt) run.endedAt = Date.now();

    if (!this.opened) {
      this.orb.classList.toggle("work", this.working);
      return true;
    }
    if (this.view === "run") this.render();
    else this.orb.classList.toggle("work", this.working);
    if (run.result) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = window.setTimeout(() => {
        if (this.opened && this.view === "run" && !this.input.value && !this.bar.matches(":hover") && !run.expanded) this.hide();
      }, AUTO_CLOSE_MS);
    }
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.opened || event.isComposing) return false;
    const { key } = event;
    if (key === "Escape") {
      if (this.view === "settings") this.setView("list");
      else this.hide();
      return true;
    }
    const inSearchField = this.shadow.activeElement === this.input;
    if (key === "Backspace" && inSearchField && !this.input.value && (this.view === "settings" || (this.view === "run" && this.run?.result))) {
      this.setView("list");
      return true;
    }
    if (key === "Tab" && this.view !== "settings") {
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
