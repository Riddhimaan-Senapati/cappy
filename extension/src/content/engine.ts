import type { ActiveChange, Change, DomOp } from "../../../shared/adaptation.js";
import { detectInjectionFields } from "../../../shared/safety.js";
import { isOneShot, isScheduleActive, savedChangeOnThisPage, validateChange } from "../../../shared/validate.js";
import type { ApplyOutcome, SiteControlOutcome } from "../../../shared/protocol.js";
import { applyBlock } from "./blocks.js";
import { keywordPattern, leftovers } from "./content-filter.js";
import { accessibleName, isOwn, LABELLABLE, OWN_ATTR, queryIn } from "./dom.js";
import { computeStats, lowContrastSamples, readInjectionSurface } from "./outline.js";
import { isSiteControlInput, siteControlId, useSiteControl } from "./site-controls.js";

type Undo = () => void;
type Reapply = (roots: Element[]) => void;

interface Live {
  undo: Undo[];
  reapply: Reapply[];
  note?: Promise<string>;
  adoptReapply?: () => void;
}

// live is null while the change's schedule is off; the change stays registered so it can switch on without a reload.
interface Applied {
  change: ActiveChange;
  live: Live | null;
}

const applied = new Map<string, Applied>();
const siteControls = new Map<string, { change: ActiveChange; restore: () => Promise<boolean> }>();
const SCHEDULE_TICK_MS = 30_000;
let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
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

function liveOp(op: DomOp, hint = ""): LiveOp {
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
    if (op.op === "reorder") {
      // A tile that loads later is the only node in the reapply root, so pull in its matching siblings.
      // Walk each parent once; scanning every child for every item is quadratic on a large grid.
      const parents = new Set<Element>();
      for (const item of elements) if (item.parentElement) parents.add(item.parentElement);
      const withSiblings = new Set(elements);
      for (const parent of parents) {
        for (const child of parent.children) {
          if (child.matches(op.selector)) withSiblings.add(child);
        }
      }
      const problem = sortItems(op, [...withSiblings], originalOrder, undoSteps, hint);
      if (problem) throw new Error(problem);
    }
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
      const dom = liveOp(op, `${change.summary} ${change.reason}`);
      // Register undo before run so a check that fails after moving nodes can put them back.
      live.undo.push(dom.undo);
      matched[`${op.op} ${op.selector}`] = dom.run([document]);
      live.reapply.push((roots) => void dom.run(roots));
    }
    if (change.block) {
      const block = applyBlock(change.block);
      live.undo.push(block.undo);
      if (block.reapply) live.reapply.push(block.reapply);
      live.adoptReapply = () => {
        if (block.reapply && !live.reapply.includes(block.reapply)) live.reapply.push(block.reapply);
      };
      if (block.note) live.note = block.note;
      if (block.matched && change.block.name === "contentFilter") {
        matched[`contentFilter ${change.block.itemSelector ?? "all item groups"}`] = block.matched();
        if (change.block.action === "hide") matched["contentFilter still showing"] = leftovers(document, keywordPattern(change.block.keywords));
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
  const promoted = op.keywords?.length ? keywordPattern(op.keywords) : null;
  const ranking = op.ranking?.length ? op.ranking : null;
  if (!ranking) {
    return (a: Element, b: Element) => {
      if (promoted) {
        const left = promoted.test(keyText(a, op.keySelector)) ? 0 : 1;
        const right = promoted.test(keyText(b, op.keySelector)) ? 0 : 1;
        if (left !== right) return left - right;
      }
      return collator.compare(keyText(a, op.keySelector), keyText(b, op.keySelector)) * direction;
    };
  }
  const ranks = new Map(ranking.map((entry) => [entry.key.replace(/\s+/g, " ").trim().toLowerCase(), entry.rank]));
  const front = Math.min(...ranking.map((entry) => entry.rank));
  const rankOf = (item: Element) => {
    const listed = ranks.get(keyText(item, op.keySelector).toLowerCase());
    if (listed !== undefined) return listed;
    // A cooking video that loads later was not in the ranking, but it is still the kind the user put first.
    if (promoted?.test(keyText(item, op.keySelector))) return front;
    return undefined;
  };
  return (a: Element, b: Element) => {
    const [x, y] = [rankOf(a), rankOf(b)];
    if (x === undefined || y === undefined) return x === undefined ? (y === undefined ? 0 : 1) : -1;
    return x - y;
  };
}

function matchesGroup(row: Element, groupSelector: string | null): boolean {
  if (!groupSelector) return false;
  try {
    return row.matches(groupSelector);
  } catch {
    return false;
  }
}

function storyCluster(item: Element, selected: Set<Element>, groupSelector: string | null): Element[] {
  const cluster = [item];
  let next = item.nextElementSibling;
  while (next && cluster.length < 4 && !selected.has(next) && matchesGroup(next, groupSelector)) {
    cluster.push(next);
    next = next.nextElementSibling;
  }
  return cluster;
}

function metricKind(hint: string): "points" | "comments" | null {
  if (/\balphabet/i.test(hint) || /\bignor(?:e|ing)\s+(?:the\s+)?points?\b/i.test(hint)) return null;
  if (/\bcomments?\b/i.test(hint) && !/\bpoints?\b/i.test(hint)) return "comments";
  if (/\bpoints?\b/i.test(hint)) return "points";
  return null;
}

function metricValue(text: string, kind: "points" | "comments"): number | null {
  const match = text.match(kind === "comments" ? /(\d[\d,]*)\s+comments?\b/i : /(\d[\d,]*)\s+points?\b/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function clusterText(item: Element, clusters: Map<Element, Element[]>): string {
  return (clusters.get(item) ?? [item]).map((node) => node.textContent ?? "").join(" ");
}

function sortItems(op: Extract<DomOp, { op: "reorder" }>, items: Element[], originalOrder: Map<Element, Element[]>, undoSteps: Undo[], hint: string): string | null {
  const byParent = new Map<Element, Element[]>();
  for (const item of items) {
    if (!item.parentElement) continue;
    const group = byParent.get(item.parentElement) ?? [];
    group.push(item);
    byParent.set(item.parentElement, group);
  }
  const selected = new Set(items);
  const groupSelector = op.groupSelector ?? null;
  const clusters = new Map(items.map((item) => [item, storyCluster(item, selected, groupSelector)]));
  const kind = metricKind(hint);
  const descending = /\b(highest|most)\b/i.test(hint) || (!/\b(lowest|fewest)\b/i.test(hint) && op.direction !== "asc");
  for (const [parent, group] of byParent) {
    if (group.length < 2) continue;
    const current = [...parent.children].filter((child) => group.includes(child));
    const scoreOf = (item: Element) => (kind ? metricValue(clusterText(item, clusters), kind) : null);
    const known = current.map(scoreOf).filter((score): score is number => score != null);
    const ranked = Boolean(op.ranking?.length);
    const enough = known.length >= Math.ceil(current.length * 0.6);
    if (kind && !ranked && !enough) return `Could not read a ${kind} count on enough rows to sort them. Nothing was kept.`;
    const numeric = Boolean(kind) && !ranked && enough;
    const sorted = numeric
      ? [...current].sort((a, b) => {
          const left = scoreOf(a);
          const right = scoreOf(b);
          if (left == null || right == null) return left == null ? 1 : -1;
          return descending ? right - left : left - right;
        })
      : [...current].sort(compareKeys(op));
    // Only move nodes when out of order, so our own moves do not retrigger the observer forever.
    const already = sorted.every((item, index) => item === current[index]);
    if (!already) {
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
      for (const node of clusters.get(item) ?? [item]) {
        if (cursor) cursor.after(node);
        else parent.prepend(node);
        cursor = node;
      }
    }
    }
    const domOrder = already ? current : [...parent.children].filter((child) => current.includes(child));
    if (kind) {
      const sequence = domOrder.map((item) => metricValue([item, ...followingTail(item, groupSelector)].map((node) => node.textContent ?? "").join(" "), kind));
      const scored = sequence.filter((score): score is number => score != null);
      const ordered = scored.every((score, index) => index === 0 || (descending ? scored[index - 1]! >= score : scored[index - 1]! <= score));
      if (!ordered) return `The ${kind} are not in order (${sequence.map((score) => score ?? "?").slice(0, 8).join(", ")}). Rank by that number and move each title row with the rows under it. Nothing was kept.`;
    }
    if (op.ranking?.length) {
      const rankOf = (item: Element) => op.ranking?.find((entry) => entry.key.replace(/\s+/g, " ").trim().toLowerCase() === keyText(item, op.keySelector).toLowerCase())?.rank;
      let previous: number | null = null;
      for (const item of domOrder) {
        const rank = rankOf(item);
        if (rank == null) continue;
        if (previous != null && rank < previous) return `The ranking did not land in order. Nothing was kept.`;
        previous = rank;
      }
    }
  }
  return null;
}

function followingTail(item: Element, groupSelector: string | null): Element[] {
  const tail: Element[] = [];
  let next = item.nextElementSibling;
  while (next && tail.length < 3 && matchesGroup(next, groupSelector)) {
    tail.push(next);
    next = next.nextElementSibling;
  }
  return tail;
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

function nextScheduleDelay(now = Date.now()): number {
  let delay = SCHEDULE_TICK_MS;
  for (const entry of applied.values()) {
    const untilAt = entry.change.schedule?.untilAt;
    if (!untilAt) continue;
    const at = Date.parse(untilAt);
    if (Number.isNaN(at)) continue;
    const remaining = at - now;
    // Land just after the instant so the check sees the span as over.
    if (remaining > 0) delay = Math.min(delay, remaining + 25);
  }
  return delay;
}

let focusOn = false;
let focusMode = false;
const focusListeners = new Set<(on: boolean) => void>();

// Focus mode keeps every focus rule on, ignoring its times, until the user turns it off.
function scheduleOn(schedule: Change["schedule"], now: Date): boolean {
  return focusMode || isScheduleActive(schedule, now);
}

export function setFocusMode(on: boolean) {
  if (focusMode === on) return;
  focusMode = on;
  syncSchedules();
  publishFocus();
}

export function focusLive(): boolean {
  return focusMode || [...applied.values()].some((entry) => entry.change.schedule != null && entry.live !== null);
}

export function onFocusLive(listener: (on: boolean) => void): () => void {
  focusListeners.add(listener);
  listener(focusLive());
  return () => focusListeners.delete(listener);
}

function publishFocus() {
  const on = focusLive();
  if (on === focusOn) return;
  focusOn = on;
  for (const listener of focusListeners) listener(on);
}

const dropListeners = new Set<(id: string) => void>();

export function onChangeDropped(listener: (id: string) => void): () => void {
  dropListeners.add(listener);
  return () => dropListeners.delete(listener);
}

function dropChange(id: string) {
  applied.delete(id);
  changeLog.delete(id);
  for (const listener of dropListeners) listener(id);
}

function manageScheduleTimer() {
  if (scheduleTimer !== undefined) {
    clearTimeout(scheduleTimer);
    scheduleTimer = undefined;
  }
  if (![...applied.values()].some((entry) => entry.change.schedule)) return;
  scheduleTimer = setTimeout(() => syncSchedules(), nextScheduleDelay());
}

// Switches scheduled changes on or off to match the clock. Runs on a timer, on visibilitychange and after each apply.
function syncSchedules() {
  const now = new Date();
  const due = [...applied.values()].filter((entry) => entry.change.schedule && scheduleOn(entry.change.schedule, now) !== (entry.live !== null));
  if (due.length) {
    void transition(() => {
      for (const entry of due) {
        if (applied.get(entry.change.id) !== entry) continue;
        if (entry.live) {
          unwind(entry.live);
          if (isOneShot(entry.change.schedule)) dropChange(entry.change.id);
          else entry.live = null;
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
      publishFocus();
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
  const reduceMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      if (record.type === "attributes" && record.target instanceof Element && !isOwn(record.target)) pendingRoots.add(record.target);
      const removedOwn = [...record.removedNodes].some((node) => node instanceof Element && node.hasAttribute(OWN_ATTR));
      if (removedOwn && record.target instanceof Element) pendingRoots.add(record.target);
    }
    if (pendingRoots.size && flushTimer === undefined) flushTimer = setTimeout(flush, 120);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
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
    const waiting = entry.change.schedule != null && !scheduleOn(entry.change.schedule, new Date());
    if (isOneShot(entry.change.schedule) && waiting) {
      changeLog.delete(entry.change.id);
      return;
    }
    entry.live = waiting ? null : materialize(entry.change, matched);
    applied.set(entry.change.id, entry);
    changeLog.delete(entry.change.id);
    if (!isOneShot(entry.change.schedule)) changeLog.set(entry.change.id, entry.change);
    if (entry.live?.reapply.length) startObserving();
    manageScheduleTimer();
  }, animate);
  const note = await entry.live?.note;
  entry.live?.adoptReapply?.();
  if (entry.live?.reapply.length) startObserving();
  publishFocus();
  return note;
}

// View transitions and pulses can introduce temporary animations during verification.
// ":has(a[href*=shorts])" on a results list matches the list itself, since one Short sits inside it. Measured before applying.
const BROAD_SHARE = 0.4;
function broadHasSelector(css: string, pageText: number): { selector: string; percent: number } | null {
  if (!css.includes(":has(") || pageText < 1500) return null;
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return null;
  }
  const rules: CSSStyleRule[] = [];
  const collect = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) rules.push(rule);
      else if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  collect(sheet.cssRules);
  for (const rule of rules) {
    for (const selector of rule.selectorText.split(/,(?![^(]*\))/)) {
      if (!selector.includes(":has(")) continue;
      let elements: Element[] = [];
      try {
        elements = Array.from(document.querySelectorAll(selector.trim()));
      } catch {
        continue;
      }
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || isOwn(element)) continue;
        const share = element.innerText.replace(/\s+/g, " ").length / pageText;
        if (share >= BROAD_SHARE) return { selector: selector.trim(), percent: Math.round(share * 100) };
      }
    }
  }
  return null;
}

// innerText skips hidden elements, so a broad :has() selector that hides whole result lists shows up as a collapse here.
function visibleTextLength(): number {
  return (document.body?.innerText ?? "").replace(/\s+/g, " ").length;
}

function observedProblems(
  { runningAnimations: _runningAnimations, lowContrastText, ...stats }: ReturnType<typeof computeStats>,
  change: Change,
): number {
  // Dark mode checks the rendered theme separately. The generic contrast count cannot see CSS filters.
  const contrastProblems = change.block?.name === "darkMode" ? 0 : lowContrastText;
  return Object.values(stats).reduce((sum, count) => sum + count, contrastProblems);
}

// Stats stand-in when a saved change is reapplied without verification.
const UNMEASURED: ApplyOutcome["before"] = { inputsWithoutLabel: 0, smallTargets: 0, smallText: 0, lowContrastText: 0, imagesWithoutAlt: 0, runningAnimations: 0, visibleAdsOrPopups: 0 };

export interface ApplyOptions {
  // Verification scans the whole page twice per change; a saved change was verified when it was made.
  verify?: boolean;
  // The user asked for this change, so a rise in page-wide problem counts is reported instead of undoing it.
  keepIfWorse?: boolean;
  // The caller already ran the injection check on this page (restore checks once, not once per change).
  pageChecked?: boolean;
}

export async function applyChange(change: Change, animate = true, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const verify = options.verify ?? animate;
  // Recipe replay and page-load restore call this too, so a trap page is refused before any DOM write.
  const injection = options.pageChecked ? null : detectInjectionFields(readInjectionSurface());
  if (injection) {
    const before = computeStats();
    return { ok: false, error: `Blocked: this page tried to instruct the agent (${injection}).`, matched: {}, before, after: before };
  }
  ensureBaseStyle();
  const problem = validateChange(change);
  if (problem) {
    const before = computeStats();
    return { ok: false, error: problem, matched: {}, before, after: before };
  }
  if (!savedChangeOnThisPage(change, globalThis.location.pathname)) {
    const before = computeStats();
    return { ok: false, error: "Saved for a different page.", matched: {}, before, after: before };
  }

  const replaced = competingSorts(change);
  if (replaced.length) await transition(() => replaced.forEach(revertNow), false);
  const previous = applied.get(change.id);
  const before = verify ? computeStats() : UNMEASURED;
  const textBefore = verify ? visibleTextLength() : 0;
  const broad = verify && change.css ? broadHasSelector(change.css, textBefore) : null;
  if (broad) {
    return { ok: false, error: `The selector "${broad.selector.slice(0, 160)}" matches a container holding ${broad.percent}% of the page's visible text, so it would hide far more than asked. Put :has() on the card or shelf itself instead. Nothing was changed.`, matched: {}, before, after: before };
  }
  const visual = Boolean(change.css || (change.block && change.block.name !== "stopMotion"));
  const attempts = verify ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const entry: Applied = { change: { ...change, appliedAt: Date.now() }, live: null };
    const matched: Record<string, number> = {};
    let after = before;
    let error: string;
    try {
      const note = await installChange(entry, matched, animate);
      after = entry.live && verify ? computeStats() : before;
      const counts = Object.values(matched);
      const missed = !change.block && counts.length > 0 && counts.every((count) => count === 0);
      const increase = verify ? observedProblems(after, change) - observedProblems(before, change) : 0;
      const textAfter = verify && entry.live ? visibleTextLength() : textBefore;
      const hidMost = textBefore > 1500 && textAfter < textBefore * 0.35;
      const worsened = increase > 0 && !options.keepIfWorse;
      if (!verify || !entry.live || (!missed && !worsened)) {
        return {
          ok: true, matched, before, after, note,
          ...(increase > 0 ? { worsened: increase } : {}),
          ...(hidMost ? { hidMostOfPage: { textBefore, textAfter } } : {}),
          ...(!entry.live ? { waitingForSchedule: true } : {}),
          ...(visual && entry.live && verify ? { lowContrast: lowContrastSamples() } : {}),
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
  publishFocus();
  return reverted;
}

export async function revertAll(animate = true) {
  for (const id of [...siteControls.keys()].reverse()) await revertChange(id, false);
  await transition(() => [...applied.keys()].forEach(revertNow), animate);
  publishFocus();
}

export function stopEngine() {
  clearTimeout(scheduleTimer);
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

export function rescopeLiveChanges(updates: ReadonlyArray<{ id: string; scope: ActiveChange["scope"]; pagePath?: string | null }>) {
  for (const update of updates) {
    const next = (change: ActiveChange): ActiveChange => ({ ...change, scope: update.scope, pagePath: update.pagePath });
    const entry = applied.get(update.id);
    if (entry) entry.change = next(entry.change);
    const logged = changeLog.get(update.id);
    if (logged) changeLog.set(update.id, next(logged));
  }
}

export function activeChanges(): ActiveChange[] {
  return [...applied.values(), ...siteControls.values()].map((entry) => entry.change);
}

let busyTimer: ReturnType<typeof setTimeout> | undefined;
// The page-load blur hides a flash of unadapted content, not the whole model run; changes that land later still animate in.
const BUSY_BLUR_MS = 1500;

export function setBusy(on: boolean) {
  ensureBaseStyle();
  document.documentElement.classList.toggle("ba-busy", on);
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => document.documentElement.classList.remove("ba-busy"), BUSY_BLUR_MS);
}

export function engineStatus() {
  return { observing: observer !== null, liveChanges: [...applied.values()].filter((entry) => (entry.live?.reapply.length ?? 0) > 0).length };
}
