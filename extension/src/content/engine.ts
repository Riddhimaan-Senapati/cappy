import type { ActiveChange, Change, DomOp } from "../../../shared/adaptation.js";
import { validateChange } from "../../../shared/validate.js";
import type { ApplyOutcome } from "../../../shared/protocol.js";
import { applyBlock } from "./blocks.js";
import { LABELLABLE, OWN_ATTR, queryAll } from "./dom.js";
import { computeStats } from "./outline.js";

type Undo = () => void;

const applied = new Map<string, { change: ActiveChange; undo: Undo[] }>();
let generatedIds = 0;

const BASE_CSS = `
.ba-label { display: block !important; font: 600 0.95rem/1.3 system-ui, sans-serif !important; margin: 0.6em 0 0.25em !important; color: inherit !important; }
@keyframes ba-pulse { 0% { box-shadow: 0 0 0 0 rgba(66, 133, 244, 0.7); } 100% { box-shadow: 0 0 0 12px rgba(66, 133, 244, 0); } }
.ba-pulse { animation: ba-pulse 0.9s ease-out 2 !important; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 0.45s; animation-timing-function: ease-in-out; }
html.ba-busy body { filter: blur(3px) saturate(0.7); transition: filter 0.3s ease; }
`;

function ensureBaseStyle() {
  if (document.querySelector(`style[${OWN_ATTR}="base"]`)) return;
  const style = document.createElement("style");
  style.setAttribute(OWN_ATTR, "base");
  style.textContent = BASE_CSS;
  document.documentElement.append(style);
}

function pulse(elements: Element[]) {
  elements.forEach((element) => {
    element.classList.add("ba-pulse");
    setTimeout(() => element.classList.remove("ba-pulse"), 1900);
  });
}

function applyCss(change: Change, matched: Record<string, number>): Undo {
  const style = document.createElement("style");
  style.setAttribute(OWN_ATTR, `change:${change.id}`);
  style.textContent = change.css ?? "";
  document.documentElement.append(style);

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(change.css ?? "");
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue;
    const testable = rule.selectorText.replace(/::?(before|after|placeholder|selection|marker|first-line|first-letter|hover|focus-visible|focus-within|focus|active|visited)\b/g, "");
    try {
      matched[rule.selectorText] = document.querySelectorAll(testable || "*").length;
    } catch {
      matched[rule.selectorText] = -1;
    }
  }
  return () => style.remove();
}

function applyDomOp(op: DomOp, matched: Record<string, number>, touched: Element[]): Undo[] {
  const elements = queryAll(op.selector);
  matched[`${op.op} ${op.selector}`] = elements.length;
  const undo: Undo[] = [];

  for (const element of elements) {
    switch (op.op) {
      case "addLabel": {
        if (!element.matches(LABELLABLE)) break;
        let createdId = false;
        if (!element.id) {
          element.id = `ba-field-${++generatedIds}`;
          createdId = true;
        }
        const label = document.createElement("label");
        label.className = "ba-label";
        label.setAttribute(OWN_ATTR, "label");
        label.htmlFor = element.id;
        label.textContent = op.text;
        element.before(label);
        touched.push(label);
        undo.push(() => {
          label.remove();
          if (createdId) element.removeAttribute("id");
        });
        break;
      }
      case "setAttribute":
      case "removeAttribute": {
        const previous = element.getAttribute(op.name);
        if (op.op === "setAttribute") element.setAttribute(op.name, op.value);
        else element.removeAttribute(op.name);
        undo.push(() => (previous === null ? element.removeAttribute(op.name) : element.setAttribute(op.name, previous)));
        break;
      }
      case "pauseMedia": {
        if (element instanceof HTMLMediaElement && !element.paused) element.pause();
        break;
      }
    }
  }
  return undo;
}

function revertNow(id: string): boolean {
  const entry = applied.get(id);
  if (!entry) return false;
  [...entry.undo].reverse().forEach((undo) => undo());
  applied.delete(id);
  return true;
}

async function transition(update: () => void, animate: boolean) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduceMotion || !document.startViewTransition) return update();
  await document.startViewTransition(update).updateCallbackDone;
}

export async function applyChange(change: Change, animate = true): Promise<ApplyOutcome> {
  ensureBaseStyle();
  const problem = validateChange(change);
  const before = computeStats();
  if (problem) return { ok: false, error: problem, matched: {}, before, after: before };

  const matched: Record<string, number> = {};
  const touched: Element[] = [];
  let error: string | undefined;

  await transition(() => {
    revertNow(change.id);
    const undo: Undo[] = [];
    try {
      if (change.css) undo.push(applyCss(change, matched));
      for (const op of change.dom ?? []) undo.push(...applyDomOp(op, matched, touched));
      if (change.block) undo.push(applyBlock(change.block));
      applied.set(change.id, { change: { ...change, appliedAt: Date.now() }, undo });
    } catch (caught) {
      [...undo].reverse().forEach((step) => step());
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }, animate);

  if (animate) pulse(touched);
  return { ok: !error, error, matched, before, after: computeStats() };
}

export async function revertChange(id: string, animate = true): Promise<boolean> {
  let reverted = false;
  await transition(() => {
    reverted = revertNow(id);
  }, animate);
  return reverted;
}

export async function revertAll(animate = true) {
  await transition(() => [...applied.keys()].forEach(revertNow), animate);
}

export function activeChanges(): ActiveChange[] {
  return [...applied.values()].map((entry) => entry.change);
}

export function setBusy(on: boolean) {
  ensureBaseStyle();
  document.documentElement.classList.toggle("ba-busy", on);
}
