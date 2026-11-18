import { describeElement, isOwn, OWN_ATTR } from "./dom.js";

const CSS = `
:host { all: initial; }
.outline { position: fixed; pointer-events: none; border: 2px solid #8b9bff; border-radius: 6px; background: rgba(139,155,255,.08);
  box-shadow: 0 0 0 4px rgba(139,155,255,.18); transition: left .06s, top .06s, width .06s, height .06s; }
.label { position: fixed; pointer-events: none; padding: 3px 8px; border-radius: 6px; background: rgba(20,20,26,.94); color: #f4f4f7;
  font: 12px system-ui, sans-serif; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: rgba(20,20,26,.94);
  color: #c9c9d3; font: 12.5px system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.35); animation: in .25s ease; }
.hint b { color: #fff; font-weight: 600; }
@keyframes in { from { opacity: 0; transform: translate(-50%, -6px); } }
`;

// A DevTools-style element picker so mouse and keyboard users can point at something, like the camera pinch-and-hold.
export class ElementPicker {
  private host = document.createElement("div");
  private outline = document.createElement("div");
  private label = document.createElement("div");
  private current: Element | null = null;
  private active = false;

  constructor(
    private onPick: (element: Element) => void,
    private onCancel: () => void,
  ) {
    this.host.setAttribute(OWN_ATTR, "picker");
    this.host.setAttribute("popover", "manual");
    this.host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;background:transparent!important;border:0!important;margin:0!important;padding:0!important";
    const shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    this.outline.className = "outline";
    this.label.className = "label";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.setAttribute("role", "status");
    for (const [key, text] of [["Click", " to choose"], ["↑↓", " parent or child"], ["Enter", " to choose"], ["Esc", " to cancel"]]) {
      const bold = document.createElement("b");
      bold.textContent = key;
      hint.append(bold, document.createTextNode(`${text}   `));
    }
    shadow.append(style, this.outline, this.label, hint);
  }

  get isActive() {
    return this.active;
  }

  start() {
    if (this.active) return;
    this.active = true;
    document.documentElement.append(this.host);
    try {
      this.host.showPopover();
    } catch {
      // fixed host still renders without popover support
    }
    document.documentElement.style.setProperty("cursor", "crosshair", "important");
    addEventListener("mousemove", this.onMove, true);
    addEventListener("click", this.onClick, true);
    addEventListener("mousedown", this.swallow, true);
    addEventListener("mouseup", this.swallow, true);
    addEventListener("keydown", this.onKey, true);
    const focused = document.activeElement;
    this.show(focused && focused !== document.body ? focused : document.querySelector("main, h1, body > *"));
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    document.documentElement.style.removeProperty("cursor");
    removeEventListener("mousemove", this.onMove, true);
    removeEventListener("click", this.onClick, true);
    removeEventListener("mousedown", this.swallow, true);
    removeEventListener("mouseup", this.swallow, true);
    removeEventListener("keydown", this.onKey, true);
    this.host.remove();
    this.current = null;
  }

  private pickable(element: Element | null): Element | null {
    if (!element || element === document.documentElement || element === document.body || isOwn(element)) return null;
    return element;
  }

  private show(element: Element | null) {
    const target = this.pickable(element);
    if (!target) return;
    this.current = target;
    const rect = target.getBoundingClientRect();
    Object.assign(this.outline.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
    this.label.textContent = describeElement(target);
    Object.assign(this.label.style, { left: `${Math.min(innerWidth - 310, Math.max(8, rect.left))}px`, top: `${rect.top > 34 ? rect.top - 28 : rect.bottom + 6}px` });
  }

  private onMove = (event: MouseEvent) => this.show(document.elementFromPoint(event.clientX, event.clientY));

  private swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private onClick = (event: MouseEvent) => {
    this.swallow(event);
    const target = this.pickable(document.elementFromPoint(event.clientX, event.clientY)) ?? this.current;
    this.finish(target);
  };

  private onKey = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    const handled = ["Escape", "Enter", "ArrowUp", "ArrowDown"].includes(event.key);
    if (!handled) return;
    this.swallow(event);
    if (event.key === "Escape") {
      this.stop();
      this.onCancel();
    } else if (event.key === "Enter") this.finish(this.current);
    else if (event.key === "ArrowUp") this.show(this.current?.parentElement ?? null);
    else if (event.key === "ArrowDown") this.show(this.current?.firstElementChild ?? null);
  };

  private finish(target: Element | null) {
    this.stop();
    if (target) this.onPick(target);
    else this.onCancel();
  }
}
