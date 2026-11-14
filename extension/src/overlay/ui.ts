import type { UiEvent } from "../messages.js";
import { forgetLine } from "../memory.js";
import { adoptStyles, h, icon } from "../ui/dom.js";
import { SETTINGS_CSS, TOKENS } from "../ui/theme.js";
import { VOICE_CSS } from "../voice/styles.js";
import { Spotlight, type SpotlightDeps } from "./spotlight.js";
import { OVERLAY_CSS } from "./styles.js";

const TOAST_MS = 9000;

type ToastAction = { label: string; run: () => Promise<void> };

export class OverlayUi {
  readonly host = document.createElement("div");
  readonly spotlight: Spotlight;
  private shadow: ShadowRoot;
  private fab = h("button", "fab");
  private fabOrb = h("div", "orb");
  private toast: HTMLElement | null = null;
  private toastTimer: number | undefined;
  private triggers = new Map<string, string>();
  private fabWanted = false;
  private speakPill: HTMLElement | null = null;

  constructor(private deps: SpotlightDeps) {
    this.host.setAttribute("data-ba", "ui");
    this.host.setAttribute("popover", "manual");
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    adoptStyles(this.shadow, TOKENS + SETTINGS_CSS + OVERLAY_CSS + VOICE_CSS);

    this.spotlight = new Spotlight(this.shadow, deps, (open) => {
      this.fab.classList.toggle("hide", open);
      if (open) this.bringToFront();
    });
    this.fab.type = "button";
    this.fab.setAttribute("aria-label", "Open adaptive agent");
    this.fab.append(this.fabOrb);
    this.fab.addEventListener("click", () => this.spotlight.toggle());
    this.shadow.append(this.fab);
    document.documentElement.append(this.host);
    this.bringToFront();
  }

  bringToFront() {
    try {
      this.host.hidePopover();
      this.host.showPopover();
    } catch {
      // popover unsupported: the fixed host still renders, just not in the top layer
    }
  }

  setFab(visible: boolean) {
    this.fabWanted = visible;
    requestAnimationFrame(() => this.fab.classList.toggle("show", this.fabWanted));
  }

  captureKey(event: KeyboardEvent) {
    if (!this.spotlight.isOpen() || !event.composedPath().includes(this.host)) return;
    event.stopImmediatePropagation();
    if (event.type === "keydown" && this.spotlight.handleKey(event)) event.preventDefault();
  }

  handleEvent(event: UiEvent) {
    if (event.type === "start") this.triggers.set(event.runId, event.trigger);
    const handled = this.spotlight.handleEvent(event);
    if (event.type === "memory") {
      if (!(handled && this.spotlight.isOpen())) this.announceMemory(event.status, event.lines);
      return;
    }
    const working = event.type === "start" || event.type === "step" || event.type === "tier";
    this.fabOrb.classList.toggle("work", working);

    const isResult = event.type === "done" || event.type === "error" || event.type === "blocked";
    if (!isResult || this.triggers.get(event.runId) !== "chat" || (handled && this.spotlight.isOpen())) return;
    this.triggers.delete(event.runId);

    if (event.type === "done" && event.applied.length) {
      this.showToast(`Done: ${event.applied.map((change) => change.summary).join(", ")}.`, event.applied.map((change) => change.id));
    } else if (event.type === "done") {
      if (event.reply) this.showToast(event.reply, []);
    } else if (event.type === "error") {
      this.showToast(event.message, [], true);
    } else {
      this.showToast("Blocked. This page tried to give the agent instructions.", [], true);
    }
  }

  private announceMemory(status: "saved" | "proposed", lines: string[]) {
    const text = lines.join("; ");
    if (status === "proposed") return this.showToast(`Suggested for your memory: ${text}. Accept it in the bar or settings.`, []);
    this.showToast(`Remembered: ${text}`, [], false, async () => {
      for (const line of lines) await forgetLine(line);
    });
  }

  showToast(text: string, undoIds: string[], isError = false, onUndo?: () => Promise<void>, action?: ToastAction) {
    window.clearTimeout(this.toastTimer);
    const previous = this.toast;
    if (previous) {
      previous.classList.remove("show");
      setTimeout(() => previous.remove(), 300);
    }

    const close = h("button", "link", "", [icon("x", 13)]);
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    const nodes: Node[] = [icon(isError ? "x" : "sparkle", 14), h("span", "msg", text)];
    if (undoIds.length || onUndo) {
      const undo = h("button", "link", "Undo");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        await onUndo?.();
        for (const id of [...undoIds].reverse()) await this.deps.revert(id);
        if (this.toast === toast) this.dismissToast();
      });
      nodes.push(undo);
    }
    if (action) {
      const button = h("button", "link", action.label);
      button.type = "button";
      button.addEventListener("click", () => {
        this.dismissToast();
        void action.run();
      });
      nodes.push(button);
    }
    nodes.push(close, h("div", "life"));

    const toast = h("div", `toast${isError ? " error" : ""}`, "", nodes);
    toast.setAttribute("role", "status");
    close.addEventListener("click", () => this.dismissToast());
    this.toast = toast;
    this.shadow.append(toast);
    this.bringToFront();
    requestAnimationFrame(() => toast.classList.add("show"));
    this.toastTimer = window.setTimeout(() => this.dismissToast(), TOAST_MS);
  }

  setSpeaking(on: boolean) {
    if (!on) {
      this.speakPill?.remove();
      this.speakPill = null;
      return;
    }
    if (this.speakPill) return;
    const stop = h("button", "link", "Stop");
    stop.type = "button";
    stop.addEventListener("click", () => this.deps.stopSpeaking());
    const pill = h("div", "toast speak", "", [icon("volume", 14), h("span", "msg", "Reading aloud"), stop]);
    pill.setAttribute("role", "status");
    this.speakPill = pill;
    this.shadow.append(pill);
    this.bringToFront();
    requestAnimationFrame(() => pill.classList.add("show"));
  }

  dismissToast() {
    const toast = this.toast;
    if (!toast) return;
    this.toast = null;
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 350);
  }
}
