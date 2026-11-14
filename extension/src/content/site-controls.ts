import type { SiteControl, SiteControlInput } from "../../../shared/protocol.js";
import { isOwn, isVisible } from "./dom.js";

const LABELS = /^(?:(?:toggle |use |enable |disable )?(?:(?:dark|light|night)(?: mode| theme)?|reduced motion|autoplay|closed captions|captions|subtitles|high contrast|reader mode)|(?:color |display |site )?theme|appearance|(?:text|font) size|playback speed|(?:sort|order)(?: by)?|(?:content |results? )?filter(?: by)?)$/i;
const EXCLUDED = 'a, [href], form, [form], [contenteditable="true"], [role="dialog"], [inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]';
const SELECTOR = 'button[aria-pressed], button[role="switch"][aria-checked], select';
const MAX_CONTROLS = 20;
const MAX_OPTIONS = 30;
const handles = new Map<string, { element: Element; control: SiteControl; url: string; options: HTMLOptionElement[] }>();
export function siteControlId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const labelText = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 100);

function siteControlName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) {
    const labels = [...el.labels].map((label) => label.textContent?.trim()).filter(Boolean).join(" ");
    if (labels) return labels;
  }
  const text = el instanceof HTMLSelectElement ? undefined : el.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text;
  return el.getAttribute("title")?.trim() ?? "";
}

function readSiteToggle(element: Element, shown = isVisible): boolean | undefined {
  if (!(element instanceof HTMLButtonElement) || !isAvailable(element, shown)) return;
  if (element.type !== "button" || !element.matches('button[aria-pressed], button[role="switch"][aria-checked]') ||
      element.hasAttribute("popovertarget") || element.hasAttribute("commandfor")) return;
  const state = element.getAttribute(element.getAttribute("role") === "switch" ? "aria-checked" : "aria-pressed");
  if (state === "true" || state === "false") return state === "true";
}

function isAvailable(element: HTMLButtonElement | HTMLSelectElement, shown: (element: Element) => boolean): boolean {
  return element.isConnected && !element.closest(EXCLUDED) && !element.matches(":disabled") &&
    !element.form && !isOwn(element) && shown(element);
}

function readControl(element: Element, id: string): SiteControl | undefined {
  const name = labelText(siteControlName(element));
  if (!LABELS.test(name)) return;
  if (element instanceof HTMLSelectElement) {
    if (!isAvailable(element, isVisible)) return;
    const selected = element.options[element.selectedIndex];
    if (element.multiple || !selected || selected.matches(":disabled")) return;
    const options = [...element.options].slice(0, MAX_OPTIONS).flatMap((option, index) =>
      option.matches(":disabled") || !option.label.trim() ? [] : [{ index, label: labelText(option.label) }],
    );
    return { kind: "select", id, name, selected: element.selectedIndex, options };
  }
  const on = readSiteToggle(element);
  if (on !== undefined) return { kind: "toggle", id, name, on };
}

export function findSiteFeatures(): SiteControl[] {
  handles.clear();
  const controls: SiteControl[] = [];
  for (const element of document.querySelectorAll(SELECTOR)) {
    const id = siteControlId();
    const control = readControl(element, id);
    if (!control) continue;
    handles.set(id, { element, control, url: location.href, options: element instanceof HTMLSelectElement ? [...element.options] : [] });
    controls.push(control);
    if (controls.length === MAX_CONTROLS) break;
  }
  return controls;
}

export function isSiteControlInput(input: unknown): input is SiteControlInput {
  return typeof input === "object" && input !== null && "controlId" in input && typeof input.controlId === "string" &&
    "value" in input && (typeof input.value === "boolean" || Number.isSafeInteger(input.value)) &&
    "summary" in input && typeof input.summary === "string" && input.summary.trim().length > 0 && input.summary.length <= 120 &&
    "reason" in input && typeof input.reason === "string" && input.reason.trim().length > 0 && input.reason.length <= 240;
}

function authorizedValue(control: SiteControl, request: string): number | boolean | undefined {
  const normalize = (value: string) => value.toLowerCase().trim().replace(/\s+/g, " ");
  const text = normalize(request).replace(/^please /, "").replace(/[.!?]+$/, "");
  const name = normalize(control.name).replace(/^(?:toggle|use|enable|disable) /, "");
  if (control.kind === "toggle") {
    if ([`turn on ${name}`, `enable ${name}`, `turn ${name} on`, `set ${name} to on`].includes(text)) return true;
    if ([`turn off ${name}`, `disable ${name}`, `turn ${name} off`, `set ${name} to off`].includes(text)) return false;
  } else {
    const matching = control.options.filter(({ label }) => text === `set ${name} to ${normalize(label)}`);
    if (matching.length === 1) return matching[0].index;
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

export async function useSiteControl(input: SiteControlInput, request: string): Promise<(() => Promise<boolean>) | null> {
  const handle = handles.get(input.controlId);
  if (!handle) throw new Error("Discover site features before using a control.");
  const { element, control: discovered, url } = handle;
  const sameControl = () => {
    if (location.href !== url) return;
    const current = readControl(element, input.controlId);
    if (current?.kind === discovered.kind && current.name === discovered.name) return current;
  };
  const control = sameControl();
  if (!control) throw new Error("This control is no longer available. Discover site features again.");
  if (authorizedValue(control, request) !== input.value) throw new Error("The chat request must directly name the site control and desired setting.");
  let undo: () => Promise<boolean>;
  let verified: () => boolean;
  if (control.kind === "toggle" && element instanceof HTMLButtonElement) {
    if (typeof input.value !== "boolean") throw new Error("Choose on or off for a toggle.");
    const target = input.value;
    if (control.on === target) return null;
    verified = () => {
      const current = sameControl();
      return current?.kind === "toggle" && current.on === target;
    };
    undo = async () => {
      const current = sameControl();
      if (current?.kind !== "toggle") return false;
      if (current.on === control.on) return true;
      element.click();
      await settle();
      const restored = sameControl();
      return restored?.kind === "toggle" && restored.on === control.on;
    };
    element.click();
  } else if (control.kind === "select" && element instanceof HTMLSelectElement) {
    const option = control.options.find(({ index }) => index === input.value);
    if (!option || element.options[option.index] !== handle.options[option.index] ||
        discovered.kind !== "select" || !discovered.options.some(({ index, label }) => index === option.index && label === option.label)) {
      throw new Error("Discover site features again to choose an available option.");
    }
    if (option.index === control.selected) return null;
    const beforeOption = element.options[control.selected];
    const targetOption = element.options[option.index];
    const select = (index: number, option: HTMLOptionElement) => {
      element.selectedIndex = index;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      if (sameControl() && element.selectedOptions[0] === option) element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    verified = () => {
      const current = sameControl();
      return current?.kind === "select" && current.selected === option.index && element.selectedOptions[0] === targetOption;
    };
    const beforeLabel = beforeOption.label;
    const beforeValue = beforeOption.value;
    const restored = () => sameControl()?.kind === "select" && element.selectedOptions[0] === beforeOption &&
      beforeOption.label === beforeLabel && beforeOption.value === beforeValue;
    undo = async () => {
      if (restored()) return true;
      const beforeIndex = [...element.options].indexOf(beforeOption);
      if (beforeIndex < 0 || beforeOption.matches(":disabled") || beforeOption.label !== beforeLabel ||
          beforeOption.value !== beforeValue || !verified()) return false;
      select(beforeIndex, beforeOption);
      await settle();
      return restored();
    };
    select(option.index, targetOption);
  } else {
    throw new Error("This control is no longer available.");
  }
  await settle();
  if (!verified()) throw new Error("The site did not confirm the requested control state.");
  return undo;
}
