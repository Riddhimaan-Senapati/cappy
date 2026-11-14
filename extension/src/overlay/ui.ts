import type { UiEvent } from "../messages.js";
import { adoptStyles, h, icon } from "../ui/dom.js";
import { SETTINGS_CSS, TOKENS } from "../ui/theme.js";
import { Spotlight, type SpotlightDeps } from "./spotlight.js";
import { OVERLAY_CSS } from "./styles.js";

const TOAST_MS = 9000;

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

  constructor(private deps: SpotlightDeps) {
    this.host.setAttribute("data-ba", "ui");
    this.host.setAttribute("popover", "manual");
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    adoptStyles(this.shadow, TOKENS + SETTINGS_CSS + OVERLAY_CSS);

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

  showToast(text: string, undoIds: string[], isError = false) {
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
    if (undoIds.length) {
      const undo = h("button", "link", "Undo");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        for (const id of undoIds) await this.deps.revert(id);
        this.dismissToast();
      });
      nodes.push(undo);
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

  dismissToast() {
    const toast = this.toast;
    if (!toast) return;
    this.toast = null;
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 350);
  }
}
