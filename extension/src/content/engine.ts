import type { ActiveChange, Change, DomOp } from "../../../shared/adaptation.js";
import { validateChange } from "../../../shared/validate.js";
import type { ApplyOutcome } from "../../../shared/protocol.js";
import { applyBlock } from "./blocks.js";
import { accessibleName, isOwn, LABELLABLE, OWN_ATTR, queryIn } from "./dom.js";
import { computeStats } from "./outline.js";

type Undo = () => void;
type Reapply = (roots: Element[]) => void;

interface Applied {
  change: ActiveChange;
  undo: Undo[];
  reapply: Reapply[];
}

const applied = new Map<string, Applied>();
let generatedIds = 0;
const BASE_CSS = `
.ba-label { display: block !important; font: 600 0.95rem/1.3 system-ui, sans-serif !important; margin: 0.6em 0 0.25em !important; color: inherit !important; }
@keyframes ba-pulse { 0% { box-shadow: 0 0 0 0 rgba(124, 140, 255, 0.75); } 100% { box-shadow: 0 0 0 12px rgba(124, 140, 255, 0); } }
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

interface LiveOp {
  run: (roots: ParentNode[]) => number;
  undo: Undo;
}

function liveOp(op: DomOp): LiveOp {
  const seen = new WeakSet<Element>();
  const undoSteps: Undo[] = [];
  const labels = new WeakMap<Element, HTMLLabelElement>();

  const run = (roots: ParentNode[]): number => {
    const elements = queryIn(roots, op.selector);
    for (const element of elements) {
      switch (op.op) {
        case "addLabel": {
          if (!element.matches(LABELLABLE) || accessibleName(element)) break;
          const existing = labels.get(element);
          if (existing?.isConnected) break;
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
          labels.set(element, label);
          pulse([label]);
          undoSteps.push(() => {
            label.remove();
            if (createdId) element.removeAttribute("id");
          });
          break;
        }
        case "setAttribute": {
          if (element.getAttribute(op.name) === op.value) break;
          if (!seen.has(element)) {
            const previous = element.getAttribute(op.name);
            undoSteps.push(() => (previous === null ? element.removeAttribute(op.name) : element.setAttribute(op.name, previous)));
            seen.add(element);
          }
          element.setAttribute(op.name, op.value);
          break;
        }
        case "removeAttribute": {
          if (!element.hasAttribute(op.name)) break;
          if (!seen.has(element)) {
            const previous = element.getAttribute(op.name) ?? "";
            undoSteps.push(() => element.setAttribute(op.name, previous));
            seen.add(element);
          }
          element.removeAttribute(op.name);
          break;
        }
        case "pauseMedia": {
          if (element instanceof HTMLMediaElement && !element.paused) element.pause();
          break;
        }
      }
    }
    return elements.length;
  };

  return { run, undo: () => [...undoSteps].reverse().forEach((step) => step()) };
}

function revertNow(id: string): boolean {
  const entry = applied.get(id);
  if (!entry) return false;
  [...entry.undo].reverse().forEach((undo) => undo());
  applied.delete(id);
  stopObservingIfIdle();
  return true;
}

async function transition(update: () => void, animate: boolean) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduceMotion || !document.startViewTransition || !document.body) return update();
  await document.startViewTransition(update).updateCallbackDone;
}

let observer: MutationObserver | null = null;
let pendingRoots = new Set<Element>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  flushTimer = undefined;
  const roots = [...pendingRoots].filter((root) => root.isConnected);
  pendingRoots = new Set();
  if (!roots.length) return;
  const effective = roots.length > 300 ? [document.documentElement] : roots;
  for (const entry of applied.values()) {
    for (const reapply of entry.reapply) {
      try {
        reapply(effective);
      } catch {
        // a bad selector must not stop other changes from keeping up with the page
      }
    }
  }
  observer?.takeRecords();
}

function startObserving() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && isOwn(record.target)) continue;
      for (const node of record.addedNodes) {
        if (node instanceof Element && !isOwn(node)) pendingRoots.add(node);
      }
      const removedOwn = [...record.removedNodes].some((node) => node instanceof Element && node.hasAttribute(OWN_ATTR));
      if (removedOwn && record.target instanceof Element) pendingRoots.add(record.target);
    }
    if (pendingRoots.size && flushTimer === undefined) flushTimer = setTimeout(flush, 120);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function stopObservingIfIdle() {
  if (observer && ![...applied.values()].some((entry) => entry.reapply.length)) {
    observer.disconnect();
    observer = null;
    pendingRoots = new Set();
  }
}

export async function applyChange(change: Change, animate = true): Promise<ApplyOutcome> {
  ensureBaseStyle();
  const problem = validateChange(change);
  const before = computeStats();
  if (problem) return { ok: false, error: problem, matched: {}, before, after: before };

  const matched: Record<string, number> = {};
  let error: string | undefined;

  await transition(() => {
    revertNow(change.id);
    const entry: Applied = { change: { ...change, appliedAt: Date.now() }, undo: [], reapply: [] };
    try {
      if (change.css) entry.undo.push(applyCss(change, matched));
      for (const op of change.dom ?? []) {
        const live = liveOp(op);
        matched[`${op.op} ${op.selector}`] = live.run([document]);
        entry.undo.push(live.undo);
        entry.reapply.push((roots) => void live.run(roots));
      }
      if (change.block) {
        const block = applyBlock(change.block);
        entry.undo.push(block.undo);
        if (block.reapply) entry.reapply.push(block.reapply);
      }
      applied.set(change.id, entry);
      if (entry.reapply.length) startObserving();
    } catch (caught) {
      [...entry.undo].reverse().forEach((step) => step());
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }, animate);

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

let busyTimer: ReturnType<typeof setTimeout> | undefined;

export function setBusy(on: boolean) {
  ensureBaseStyle();
  document.documentElement.classList.toggle("ba-busy", on);
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => document.documentElement.classList.remove("ba-busy"), 8000);
}
