import type { ActiveChange, Change, DomOp } from "../../../shared/adaptation.js";
import { isScheduleActive, validateChange } from "../../../shared/validate.js";
import type { ApplyOutcome, SiteControlOutcome } from "../../../shared/protocol.js";
import { applyBlock } from "./blocks.js";
import { accessibleName, isOwn, LABELLABLE, OWN_ATTR, queryIn } from "./dom.js";
import { computeStats, lowContrastSamples } from "./outline.js";
import { isSiteControlInput, siteControlId, useSiteControl } from "./site-controls.js";

type Undo = () => void;
type Reapply = (roots: Element[]) => void;

interface Live {
  undo: Undo[];
  reapply: Reapply[];
  note?: Promise<string>;
}

// live is null while the change's schedule is off; the change stays registered so it can switch on without a reload.
interface Applied {
  change: ActiveChange;
  live: Live | null;
}

const applied = new Map<string, Applied>();
const siteControls = new Map<string, { change: ActiveChange; restore: () => Promise<boolean> }>();
const SCHEDULE_TICK_MS = 30_000;
let scheduleTimer: ReturnType<typeof setInterval> | undefined;
// Every change applied on this page, including ones turned off, so history can turn them back on.
const changeLog = new Map<string, ActiveChange>();
let generatedIds = 0;
const BASE_CSS = `
.ba-label { display: block !important; font: 600 0.95rem/1.3 system-ui, sans-serif !important; margin: 0.6em 0 0.25em !important; color: inherit !important; }
@keyframes ba-pulse { 0% { box-shadow: 0 0 0 0 rgba(124, 140, 255, 0.75); } 100% { box-shadow: 0 0 0 12px rgba(124, 140, 255, 0); } }
.ba-pulse { animation: ba-pulse 0.9s ease-out 2 !important; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 0.45s; animation-timing-function: ease-in-out; }
[data-ba-target] { outline: 3px solid #8b9bff !important; outline-offset: 3px !important; border-radius: 4px; }
html.ba-busy body { filter: blur(3px) saturate(0.7); transition: filter 0.3s ease; }
`;

export function ensureBaseStyle() {
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
  const originalOrder = new Map<Element, Element[]>();

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
        case "reorder":
          break;
      }
    }
    if (op.op === "reorder") sortItems(op, elements, originalOrder, undoSteps);
    return elements.length;
  };

  return { run, undo: () => [...undoSteps].reverse().forEach((step) => step()) };
}

function unwind(live: Live) {
  [...live.undo].reverse().forEach((undo) => undo());
  live.undo = [];
  live.reapply = [];
}

// Builds every live step of a change. A failure unwinds the partial build and rethrows.
function materialize(change: Change, matched: Record<string, number>): Live {
  const live: Live = { undo: [], reapply: [] };
  try {
    if (change.css) live.undo.push(applyCss(change, matched));
    for (const op of change.dom ?? []) {
      const dom = liveOp(op);
      matched[`${op.op} ${op.selector}`] = dom.run([document]);
      live.undo.push(dom.undo);
      live.reapply.push((roots) => void dom.run(roots));
    }
    if (change.block) {
      const block = applyBlock(change.block);
      live.undo.push(block.undo);
      if (block.reapply) live.reapply.push(block.reapply);
      if (block.note) live.note = block.note;
      if (block.matched && change.block.name === "contentFilter") {
        matched[`contentFilter ${change.block.itemSelector ?? "all item groups"}`] = block.matched();
      }
      if (block.matched && change.block.name === "formFixer") matched.formFixer = block.matched();
    }
  } catch (caught) {
    unwind(live);
    throw caught;
  }
  return live;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function keyText(item: Element, keySelector: string | null) {
  const source = keySelector ? item.querySelector(keySelector) : item;
  return (source?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function compareKeys(op: Extract<DomOp, { op: "reorder" }>) {
  const direction = op.direction === "asc" ? 1 : -1;
  if (!op.ranking) return (a: Element, b: Element) => collator.compare(keyText(a, op.keySelector), keyText(b, op.keySelector)) * direction;
  const ranks = new Map(op.ranking.map((entry) => [entry.key.replace(/\s+/g, " ").trim().toLowerCase(), entry.rank]));
  const rankOf = (item: Element) => ranks.get(keyText(item, op.keySelector).toLowerCase());
  return (a: Element, b: Element) => {
    const [x, y] = [rankOf(a), rankOf(b)];
    // Items the model did not rank (for example ones that loaded later) keep their order at the end.
    if (x === undefined || y === undefined) return x === undefined ? (y === undefined ? 0 : 1) : -1;
    return x - y;
  };
}

function sortItems(op: Extract<DomOp, { op: "reorder" }>, items: Element[], originalOrder: Map<Element, Element[]>, undoSteps: Undo[]) {
  const byParent = new Map<Element, Element[]>();
  for (const item of items) {
    if (!item.parentElement) continue;
    const group = byParent.get(item.parentElement) ?? [];
    group.push(item);
    byParent.set(item.parentElement, group);
  }
  for (const [parent, group] of byParent) {
    if (group.length < 2) continue;
    const current = [...parent.children].filter((child) => group.includes(child));
    const sorted = [...current].sort(compareKeys(op));
    // Only move nodes when out of order, so our own moves do not retrigger the observer forever.
    if (sorted.every((item, i) => item === current[i])) continue;
    if (!originalOrder.has(parent)) {
      originalOrder.set(parent, [...parent.children]);
      undoSteps.push(() => {
        const original = originalOrder.get(parent) ?? [];
        for (const child of original) if (child.parentElement === parent) parent.append(child);
        originalOrder.delete(parent);
      });
    }
    const anchor = current[0].previousElementSibling;
    let cursor: Element | null = anchor;
    for (const item of sorted) {
      if (cursor) cursor.after(item);
      else parent.prepend(item);
      cursor = item;
    }
  }
}

function revertNow(id: string): boolean {
  const entry = applied.get(id);
  if (!entry) return false;
  if (entry.live) unwind(entry.live);
  applied.delete(id);
  stopObservingIfIdle();
  manageScheduleTimer();
  return true;
}

function manageScheduleTimer() {
  const scheduled = [...applied.values()].some((entry) => entry.change.schedule);
  if (scheduled && scheduleTimer === undefined) scheduleTimer = setInterval(() => syncSchedules(), SCHEDULE_TICK_MS);
  if (!scheduled && scheduleTimer !== undefined) {
    clearInterval(scheduleTimer);
    scheduleTimer = undefined;
  }
}

// Switches scheduled changes on or off to match the clock. Runs on a timer, on visibilitychange and after each apply.
function syncSchedules() {
  const now = new Date();
  const due = [...applied.values()].filter((entry) => entry.change.schedule && isScheduleActive(entry.change.schedule, now) !== (entry.live !== null));
  if (due.length) {
    void transition(() => {
      for (const entry of due) {
        if (applied.get(entry.change.id) !== entry) continue;
        if (entry.live) {
          unwind(entry.live);
          entry.live = null;
          continue;
        }
        try {
          entry.live = materialize(entry.change, {});
        } catch {
          // stays off; the next tick retries
        }
      }
      if ([...applied.values()].some((entry) => entry.live?.reapply.length)) startObserving();
      stopObservingIfIdle();
    }, true);
  }
  manageScheduleTimer();
}

document.addEventListener("visibilitychange", () => syncSchedules());

function reorderTargets(change: Change): Set<Element> {
  const targets = new Set<Element>();
  for (const op of change.dom ?? []) {
    if (op.op !== "reorder") continue;
    try {
      for (const element of document.querySelectorAll(op.selector)) targets.add(element);
    } catch {
      // invalid selectors are reported by the op itself
    }
  }
  return targets;
}

// Two live sorts on the same items would keep undoing each other, so a new sort replaces any older one.
function competingSorts(change: Change): string[] {
  const mine = reorderTargets(change);
  if (!mine.size) return [];
  return [...applied.values()]
    .filter((entry) => entry.change.id !== change.id && [...reorderTargets(entry.change)].some((element) => mine.has(element)))
    .map((entry) => entry.change.id);
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
    for (const reapply of entry.live?.reapply ?? []) {
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
  if (observer && ![...applied.values()].some((entry) => entry.live?.reapply.length)) {
    observer.disconnect();
    observer = null;
    pendingRoots = new Set();
  }
}

async function installChange(entry: Applied, matched: Record<string, number>, animate: boolean): Promise<string | undefined> {
  await transition(() => {
    revertNow(entry.change.id);
    const waiting = entry.change.schedule != null && !isScheduleActive(entry.change.schedule, new Date());
    entry.live = waiting ? null : materialize(entry.change, matched);
    applied.set(entry.change.id, entry);
    changeLog.delete(entry.change.id);
    changeLog.set(entry.change.id, entry.change);
    if (entry.live?.reapply.length) startObserving();
    manageScheduleTimer();
  }, animate);
  return entry.live?.note;
}

// View transitions and pulses can introduce temporary animations during verification.
function observedProblems(
  { runningAnimations: _runningAnimations, lowContrastText, ...stats }: ReturnType<typeof computeStats>,
  change: Change,
): number {
  // Dark mode checks the rendered theme separately. The generic contrast count cannot see CSS filters.
  const contrastProblems = change.block?.name === "darkMode" ? 0 : lowContrastText;
  return Object.values(stats).reduce((sum, count) => sum + count, contrastProblems);
}

export async function applyChange(change: Change, animate = true): Promise<ApplyOutcome> {
  ensureBaseStyle();
  const problem = validateChange(change);
  if (problem) {
    const before = computeStats();
    return { ok: false, error: problem, matched: {}, before, after: before };
  }

  const replaced = competingSorts(change);
  if (replaced.length) await transition(() => replaced.forEach(revertNow), false);
  const previous = applied.get(change.id);
  const before = computeStats();
  const visual = Boolean(change.css || (change.block && change.block.name !== "stopMotion"));
  const attempts = animate ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const entry: Applied = { change: { ...change, appliedAt: Date.now() }, live: null };
    const matched: Record<string, number> = {};
    let after = before;
    let error: string;
    try {
      const note = await installChange(entry, matched, animate);
      after = entry.live ? computeStats() : before;
      const counts = Object.values(matched);
      const missed = !change.block && counts.length > 0 && counts.every((count) => count === 0);
      const worsened = observedProblems(after, change) > observedProblems(before, change);
      if (!animate || !entry.live || (!missed && !worsened)) {
        return {
          ok: true, matched, before, after, note,
          ...(!entry.live ? { waitingForSchedule: true } : {}),
          ...(visual && entry.live ? { lowContrast: lowContrastSamples() } : {}),
          ...(replaced.length ? { replaced } : {}),
        };
      }
      error = missed ? "No elements matched the change." : "The change increased measured accessibility problems.";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    revertNow(change.id);
    if (attempt === attempts) {
      if (previous) await installChange(previous, {}, false);
      return { ok: false, error: `${error} The page was restored.`, matched, before, after };
    }
  }
  throw new Error("No verification attempt ran");
}

export async function applySiteControl(input: unknown, message: string): Promise<SiteControlOutcome> {
  if (!isSiteControlInput(input)) return { status: "unavailable", error: "Invalid site control request." };
  try {
    const undo = await useSiteControl(input, message);
    if (!undo) return { status: "already-set" };
    const change: ActiveChange = {
      id: `site-control-${siteControlId()}`,
      summary: input.summary,
      reason: input.reason,
      scope: "site",
      css: null,
      dom: null,
      block: null,
      appliedAt: Date.now(),
    };
    siteControls.set(change.id, { change, restore: undo });
    return { status: "applied", change };
  } catch (error) {
    return { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function revertChange(id: string, animate = true): Promise<boolean> {
  const siteControl = siteControls.get(id);
  if (siteControl) {
    siteControls.delete(id);
    return siteControl.restore();
  }
  let reverted = false;
  await transition(() => {
    reverted = revertNow(id);
  }, animate);
  return reverted;
}

export async function revertAll(animate = true) {
  for (const id of [...siteControls.keys()].reverse()) await revertChange(id, false);
  await transition(() => [...applied.keys()].forEach(revertNow), animate);
}

export function stopEngine() {
  clearInterval(scheduleTimer);
  scheduleTimer = undefined;
  observer?.disconnect();
  observer = null;
  pendingRoots = new Set();
}

export function changeHistory(): Array<{ change: ActiveChange; active: boolean }> {
  return [...changeLog.values()].reverse().map((change) => ({ change, active: applied.has(change.id) }));
}

export function clearChangeHistory() {
  changeLog.clear();
}

export function activeChanges(): ActiveChange[] {
  return [...applied.values(), ...siteControls.values()].map((entry) => entry.change);
}

let busyTimer: ReturnType<typeof setTimeout> | undefined;

export function setBusy(on: boolean) {
  ensureBaseStyle();
  document.documentElement.classList.toggle("ba-busy", on);
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => document.documentElement.classList.remove("ba-busy"), 8000);
}

export function engineStatus() {
  return { observing: observer !== null, liveChanges: [...applied.values()].filter((entry) => (entry.live?.reapply.length ?? 0) > 0).length };
}
