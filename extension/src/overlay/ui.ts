import type { UiEvent } from "../messages.js";
import type { MemoryScope, Suggestion } from "../../../shared/protocol.js";
import { forgetLine } from "../memory.js";
import { outcomeText, scopeChoices } from "../ui/memory-choice.js";
import { countdownRing, paintCountdown } from "../voice/button.js";
import { adoptStyles, cappyLogo, h, icon } from "../ui/dom.js";
import { SETTINGS_CSS, TOKENS } from "../ui/theme.js";
import { VOICE_CSS } from "../voice/styles.js";
import { Spotlight, type SpotlightDeps } from "./spotlight.js";
import { OVERLAY_CSS } from "./styles.js";

const TOAST_MS = 9000;
const POINTABLE = "button, a[href], input, textarea, select, [role='button'], [role='option'], [role='switch'], [role='tab'], [tabindex]:not([tabindex='-1'])";
const NUDGE_MS = 25000;

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
  private chip: HTMLElement | null = null;
  private chipTimer: number | undefined;

  constructor(private deps: SpotlightDeps) {
    this.host.setAttribute("data-ba", "ui");
    this.host.setAttribute("popover", "manual");
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    adoptStyles(this.shadow, TOKENS + SETTINGS_CSS + OVERLAY_CSS + VOICE_CSS);

    this.spotlight = new Spotlight(this.shadow, deps, (open) => {
      this.fab.classList.toggle("hide", open);
      if (open) {
        this.hideNudge();
        this.bringToFront();
      }
    }, (status) => this.showPointStatus(status));
    this.fab.type = "button";
    this.fab.setAttribute("aria-label", "Open Cappy");
    this.fabOrb.append(cappyLogo());
    this.fab.append(this.fabOrb);
    this.fab.addEventListener("click", () => {
      if (this.deps.ensureAlive()) this.spotlight.toggle();
    });
    this.shadow.append(this.fab);
    document.documentElement.append(this.host);
    this.themeQuery.addEventListener("change", this.paintTheme);
    this.paintTheme();
    this.bringToFront();
  }

  private pointPill: HTMLElement | null = null;
  private themeQuery = matchMedia("(prefers-color-scheme: light)");
  private theme: "dark" | "light" | "system" = "dark";

  setTheme(theme: "dark" | "light" | "system") {
    this.theme = theme;
    this.paintTheme();
  }

  private paintTheme = () => {
    const light = this.theme === "light" || (this.theme === "system" && this.themeQuery.matches);
    this.host.setAttribute("data-theme", light ? "light" : "dark");
  };

  // The page cannot see into this closed shadow root, so the air pointer asks here before falling through to the page.
  pointAt(x: number, y: number): { covered: boolean; control: HTMLElement | null } {
    const contains = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    // The bar's layer spans the whole viewport with pointer-events off, so only parts that really take input count.
    const takesPointer = (element: Element) => {
      const style = getComputedStyle(element);
      return style.pointerEvents !== "none" && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
    };
    const layers = [...this.shadow.children].flatMap((child) => (child === this.spotlight.layerElement ? [...child.children] : [child]));
    const covered = layers.some((layer) => contains(layer) && takesPointer(layer));
    if (!covered) return { covered: false, control: null };
    let control: HTMLElement | null = null;
    let area = Infinity;
    for (const element of this.shadow.querySelectorAll<HTMLElement>(POINTABLE)) {
      if (!contains(element) || (element as HTMLButtonElement).disabled) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width * rect.height < area) {
        area = rect.width * rect.height;
        control = element;
      }
    }
    return { covered: true, control };
  }

  // Listening without the bar: a small pill shows what was heard and what the user is pointing at.
  private showPointStatus(status: { text: string; label?: string; countdown?: number | null } | null) {
    if (!status) {
      this.pointPill?.remove();
      this.pointPill = null;
      return;
    }
    if (!this.pointPill) {
      this.pointPill = h("div", "point-pill");
      this.pointPill.setAttribute("role", "status");
      this.pointPill.setAttribute("aria-live", "polite");
      this.shadow.append(this.pointPill);
      this.bringToFront();
    }
    const heard = status.text ? h("span", "heard", status.text) : h("span", "hint", "Listening. Point at something and say what to change.");
    const dot = h("span", "dot", "", [countdownRing()]);
    paintCountdown(dot, status.countdown ?? null);
    const sending = status.countdown != null ? [h("span", "hint", "Sending")] : [];
    this.pointPill.replaceChildren(dot, heard, ...(status.label ? [h("span", "aim", "", [icon("target", 12), document.createTextNode(status.label)])] : []), ...sending);
  }

  bringToFront() {
    try {
      this.host.hidePopover();
      this.host.showPopover();
    } catch {
      // popover unsupported: the fixed host still renders, just not in the top layer
    }
  }

  destroy() {
    this.spotlight.destroy();
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.chipTimer);
    this.host.remove();
  }

  // Ghost text above the floating button. It never takes focus; the suggestion also waits pre-selected in the bar.
  nudge(suggestion: Suggestion) {
    this.spotlight.setNudge(suggestion);
    if (this.spotlight.isOpen()) return;
    this.hideNudge();

    const accept = h("button", "ghost", suggestion.text);
    accept.type = "button";
    if (suggestion.reason) accept.title = suggestion.reason;
    const dismiss = h("button", "x", "", [icon("x", 12)]);
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss suggestion");
    const chip = h("div", "nudge", "", [accept, dismiss]);
    chip.setAttribute("role", "group");
    chip.setAttribute("aria-label", "Suggestion");

    accept.addEventListener("click", () => {
      this.hideNudge();
      this.deps.acceptSuggestion(suggestion);
      this.spotlight.setNudge(null);
      this.spotlight.ask(suggestion.text, false);
    });
    dismiss.addEventListener("click", () => {
      this.hideNudge();
      this.deps.dismissSuggestion(suggestion);
      this.spotlight.setNudge(null);
    });

    this.chip = chip;
    this.shadow.append(chip);
    this.placeNudge();
    this.fabOrb.classList.add("notice");
    this.chipTimer = window.setTimeout(() => this.hideNudge(), NUDGE_MS);
  }

  // The toast uses the same corner, so a suggestion waiting above the button moves up to stay clear of it.
  private placeNudge() {
    if (!this.chip) return;
    const lift = this.toast ? this.toast.offsetHeight + 16 : 0;
    this.chip.style.bottom = `${68 + lift}px`;
  }

  // Shown when an accepted suggestion finishes, so one toast offers both Undo and where to keep the preference.
  proposeMemory(lines: string[], host: string, scope: MemoryScope, undoIds: string[] = []) {
    // The open bar already has the gray Undo on the result. The toast's Undo is the purple one, so it stays off while that bar is up.
    this.announceMemory("proposed", lines, host, scope, this.spotlight.isOpen() ? [] : undoIds);
  }

  private hideNudge() {
    window.clearTimeout(this.chipTimer);
    this.chipTimer = undefined;
    this.chip?.remove();
    this.chip = null;
    this.fabOrb.classList.remove("notice");
  }

  setFab(visible: boolean) {
    this.fabWanted = visible;
    requestAnimationFrame(() => this.fab.classList.toggle("show", this.fabWanted));
  }

  setFocus(on: boolean) {
    this.fab.classList.toggle("focus", on);
    this.fab.setAttribute("aria-label", on ? "Focus is on. Open Cappy" : "Open Cappy");
    this.spotlight.setFocus(on);
  }

  captureKey(event: KeyboardEvent) {
    if (!this.spotlight.isOpen() || !event.composedPath().includes(this.host)) return;
    event.stopImmediatePropagation();
    if (event.type === "keydown" && this.spotlight.handleKey(event)) event.preventDefault();
  }

  handleEvent(event: UiEvent) {
    if (event.type === "start") this.triggers.set(event.runId, event.trigger);
    const handled = this.spotlight.handleEvent(event);
    if (event.type === "usage") return;
    // Options need a choice, so a run started from the chip or a toast opens the bar to show them.
    if (event.type === "options" && handled && !this.spotlight.isOpen()) void this.spotlight.show("run");
    if (event.type === "memory") {
      if (!(handled && this.spotlight.isOpen())) this.announceMemory(event.status, event.lines, event.host, event.scope);
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
      this.showToast("Blocked. This page tried to give Cappy instructions.", [], true);
    }
  }

  // Proposals stay on screen until answered; ignoring one leaves it waiting in settings.
  private announceMemory(status: "saved" | "proposed", lines: string[], host?: string, scope?: MemoryScope, undoIds: string[] = []) {
    const text = lines.join("; ");
    if (status === "saved") {
      return this.showToast(`Remembered: ${text}`, [], false, async () => {
        for (const line of lines) await forgetLine(line);
      });
    }
    const actions = scopeChoices(lines, host, scope).map((choice) => ({
      label: choice.label,
      run: async () => {
        const outcome = await choice.run();
        this.showToast(`${outcomeText(outcome, host)}: ${text}`, []);
      },
    }));
    this.showToast(`Save this preference? ${text}`, undoIds, false, undefined, actions, true);
  }

  showToast(text: string, undoIds: string[], isError = false, onUndo?: () => Promise<void>, action?: ToastAction | ToastAction[], sticky = false) {
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
    const buttons: HTMLButtonElement[] = [];
    if (undoIds.length || onUndo) {
      const undo = h("button", "link", "Undo");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        await onUndo?.();
        for (const id of [...undoIds].reverse()) await this.deps.revert(id);
        if (this.toast === toast) this.dismissToast();
      });
      buttons.push(undo);
    }
    for (const each of action ? [action].flat() : []) {
      const button = h("button", "link", each.label);
      button.type = "button";
      button.addEventListener("click", () => {
        this.dismissToast();
        void each.run();
      });
      buttons.push(button);
    }
    // Several choices get their own row so the message keeps its width.
    const stacked = buttons.length > 1;
    if (stacked) nodes.push(close, h("div", "acts", "", buttons));
    else nodes.push(...buttons, close);
    if (!sticky) nodes.push(h("div", "life"));

    const toast = h("div", `toast${isError ? " error" : ""}${stacked ? " stack" : ""}`, "", nodes);
    toast.setAttribute("role", "status");
    close.addEventListener("click", () => this.dismissToast());
    this.toast = toast;
    this.shadow.append(toast);
    this.placeNudge();
    this.bringToFront();
    requestAnimationFrame(() => {
      toast.classList.add("show");
      this.placeNudge();
    });
    if (!sticky) this.toastTimer = window.setTimeout(() => this.dismissToast(), TOAST_MS);
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
    this.placeNudge();
    setTimeout(() => toast.remove(), 350);
  }
}
