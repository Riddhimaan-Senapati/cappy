import { reportExtensionError } from "../extension-context.js";
import type { ActiveChange, Change } from "../../../shared/adaptation.js";
import type { FrictionKind, Suggestion, TargetElement } from "../../../shared/protocol.js";
import type { PointedCandidate } from "../voice/point.js";
import { recordFeedback } from "../feedback.js";
import { recordFriction } from "../friction-log.js";
import { startSensors } from "./sensors.js";
import type { BackgroundRequest, ContentRequest, ContentResponse, StatusInfo, UiEvent } from "../messages.js";
import { forgetLine, hasMemoryLine, rememberLines } from "../memory.js";
import { LARGER_TEXT, learnedTextScale } from "../zoom-preference.js";
import { OverlayUi } from "../overlay/ui.js";
import { load, recordApplied, recordReverted, save, savedChangesFor, type StoredState } from "../storage.js";
import { detectInjectionFields } from "../../../shared/safety.js";
import { isOneShot } from "../../../shared/validate.js";
import { describeElement, uniqueSelector } from "./dom.js";
import { setFilterClassifier, setLeftoverListener } from "./content-filter.js";
import { activeChanges, applyChange, applySiteControl, changeHistory, clearChangeHistory, ensureBaseStyle, onChangeDropped, onFocusLive, setFocusMode, revertAll, revertChange, setBusy, stopEngine } from "./engine.js";
import { CameraController } from "./gestures/controller.js";
import { ElementPicker } from "./picker.js";
import { inspectPage, recordActivity, recordChange, recordRun, recordUsage, setEventTracking } from "./inspection.js";
import { inspect, listItems, readInjectionSurface, readPage } from "./outline.js";
import { findSiteFeatures } from "./site-controls.js";
import { speechActive, onSpeechChange, readPageAloud, stopSpeech } from "./speech.js";

const origin = location.origin;
onChangeDropped((id) => void recordReverted(origin, id));
let overlay: OverlayUi | null = null;
const suggestionCache = new Map<string, Promise<Suggestion | null>>();
const QUICK_UNDO_MS = 30_000;
// Tracks the latest accepted suggestion: its run, the memory line to offer, and when it finished.
let accepted: { suggestion: Suggestion; at: number; runId?: string; memory?: string[]; applied?: string[] } | null = null;
let stopSensors: (() => void) | null = null;
let camera: CameraController | null = null;
let lastContextElement: Element | null = null;
let targetElement: Element | null = null;
const picker = new ElementPicker(
  (element) => selectTarget(element),
  () => ensureOverlay().spotlight.show(),
);

function clearTarget() {
  targetElement?.removeAttribute("data-ba-target");
  targetElement = null;
}

// Same snapshot the inspect tool returns, so the model sees a selected element the way it sees any inspected one.
function describeTarget(element: Element): TargetElement {
  const selector = uniqueSelector(element);
  const styles = inspect(selector).samples[0]?.styles;
  return { selector, label: describeElement(element), text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160), styles };
}

function markTarget(element: Element) {
  clearTarget();
  ensureBaseStyle();
  targetElement = element;
  element.setAttribute("data-ba-target", "");
}

function selectTarget(element: Element) {
  markTarget(element);
  ensureOverlay().spotlight.showWithTarget(describeTarget(element));
}

// Point and speak: the camera pointer first, since pointing with a finger is deliberate, then whatever the mouse rests on.
let mouseAt: { x: number; y: number } | null = null;
const pointedElements = new Map<string, Element>();

// Looks through the extension's own overlay (bar, backdrop, pill, camera cursor) to the page element underneath.
function pageElementAt(x: number, y: number): Element | null {
  return document.elementsFromPoint(x, y).find((element) => element !== document.documentElement && element !== document.body && !element.closest("[data-ba]")) ?? null;
}

function pointed(): PointedCandidate<TargetElement> | null {
  const cameraAt = camera?.pointerPosition() ?? null;
  const fromCamera = cameraAt ? pageElementAt(cameraAt.x, cameraAt.y) : null;
  const element = fromCamera ?? (mouseAt ? pageElementAt(mouseAt.x, mouseAt.y) : null);
  if (!element) return null;
  const target = describeTarget(element);
  pointedElements.set(target.selector, element);
  if (pointedElements.size > 8) pointedElements.delete(pointedElements.keys().next().value!);
  return { value: target, deliberate: Boolean(fromCamera) };
}

// Pinch-and-hold selects; with camera control on, listening starts right away so the user can just say what to change.
async function selectByGesture(element: Element) {
  selectTarget(element);
  const { camera: settings } = await load();
  if (settings.speakAfterSelect !== false) await ensureOverlay().spotlight.startVoice({ hold: true }).catch(reportExtensionError);
}

let tornDown = false;

function alive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

// After the extension reloads, this copy is cut off from it; remove its UI and listeners so it stops throwing.
function teardown() {
  if (tornDown) return;
  tornDown = true;
  overlay?.destroy();
  overlay = null;
  camera?.stop();
  camera = null;
  stopEngine();
  stopSensors?.();
  for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
}

const ensureAlive = () => alive() || (teardown(), false);

// Camera control is page-independent; settings turn it on and off in every open tab.
function syncCamera(settings: StoredState["camera"], paused: boolean) {
  const wanted = settings.enabled && !paused && window.top === window;
  if (!wanted) {
    camera?.stop();
    camera = null;
    return;
  }
  if (camera) return camera.update(settings);
  camera = new CameraController(settings, {
    notify: (text) => ensureOverlay().showToast(text, []),
    turnOff: () => void load().then((state) => save({ camera: { ...state.camera, enabled: false } })),
    select: (element) => void selectByGesture(element),
    release: () => overlay?.spotlight.finishVoice(),
    hasSelection: () => Boolean(targetElement) || picker.isActive,
    pointAt: (x, y) => overlay?.pointAt(x, y) ?? { covered: false, control: null },
    cancel: () => {
      const hadSomething = Boolean(targetElement) || Boolean(overlay?.spotlight.isOpen()) || picker.isActive;
      picker.stop();
      clearTarget();
      overlay?.spotlight.hide();
      if (hadSomething) ensureOverlay().showToast("Cancelled.", []);
      return hadSomething;
    },
  });
  camera.start();
}

function send(request: BackgroundRequest): Promise<unknown> {
  if (!ensureAlive()) return Promise.resolve(undefined);
  try {
    return chrome.runtime.sendMessage(request).catch((error) => {
      reportExtensionError(error);
      return undefined;
    });
  } catch {
    teardown();
    return Promise.resolve(undefined);
  }
}

const KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

function onKey(event: KeyboardEvent) {
  if (!overlay) return;
  if (!alive()) return teardown();
  overlay.captureKey(event);
}

let pendingMutation: Promise<unknown> = Promise.resolve();

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(operation);
  pendingMutation = result.catch(() => undefined);
  return result;
}

function forThisRequest(change: Change, source: string): Change {
  if (change.scope !== "page") return change.pagePath ? { ...change, pagePath: undefined } : change;
  const askedHere = source.startsWith("Generated") || source.startsWith("Reapplied");
  const pagePath = askedHere ? location.pathname : (change.pagePath || location.pathname);
  return pagePath === change.pagePath ? change : { ...change, pagePath };
}

async function apply(change: Change, source = "Reapplied from page history locally (no LLM call)") {
  const scoped = forThisRequest(change, source);
  if (scoped.block?.name === "textScale" && scoped.id !== learnedTextScale.id) {
    await revertChange(learnedTextScale.id, false);
  }
  // A replayed recipe was verified when the model made it; only live model edits pay for the page scans.
  const outcome = await applyChange(scoped, true, { verify: !source.startsWith("Saved recipe") });
  const stored = activeChanges().find((active) => active.id === scoped.id);
  if (outcome.ok && stored && !isOneShot(stored.schedule)) {
    await recordApplied(origin, stored);
    recordChange(scoped.id, source);
  } else if (outcome.ok && isOneShot(scoped.schedule)) {
    if (!stored) await recordReverted(origin, scoped.id);
  } else recordActivity(`Could not apply ${scoped.id}: ${outcome.error ?? "No active change"}`);
  for (const id of outcome.replaced ?? []) await recordReverted(origin, id);
  if (scoped.block?.name === "textScale") await syncLearnedText();
  return outcome;
}

function revert(id: string) {
  return mutate(async () => {
    const wasTextScale = activeChanges().some((change) => change.id === id && change.block?.name === "textScale");
    const ok = await revertChange(id);
    recordActivity(`Reverted ${id}: ${ok ? "success" : "not active"}.`);
    if (id === learnedTextScale.id) {
      await forgetLine(LARGER_TEXT);
    } else if (id.startsWith("site-control-")) {
      if (!ok) ensureOverlay().showToast("The site control could not be restored.", [], true);
    } else {
      await recordReverted(origin, id);
      if (wasTextScale) await syncLearnedText();
    }
    return { ok };
  });
}

const isTyping = () => {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && (focused.isContentEditable || focused.matches("input, textarea, select"));
};

// Every friction event is logged; the gate in recordFriction decides when one is worth a model call.
async function onFriction(kind: FrictionKind) {
  if (tornDown) return;
  const { summary, nudge } = await recordFriction(location.host, kind);
  if (!nudge || isTyping() || overlay?.spotlight.isOpen()) return;
  const { paused, floatingButton } = await load();
  if (paused) return;
  const applied = activeChanges().map((change) => change.summary);
  const suggestion = (await send({ kind: "suggest", page: readPage(), applied, friction: summary })) as Suggestion | null | undefined;
  if (!suggestion || tornDown) return;
  if (floatingButton) ensureOverlay().nudge(suggestion);
  else ensureOverlay().spotlight.setNudge(suggestion);
}

async function acceptSuggestion(suggestion: Suggestion) {
  const entry: NonNullable<typeof accepted> = { suggestion, at: Date.now() };
  accepted = entry;
  await recordFeedback({ text: suggestion.text, host: location.host, outcome: "accepted" });
  if (!suggestion.memory) return;
  entry.memory = await rememberLines([suggestion.memory], { host: location.host, scope: suggestion.scope });
  offerMemory();
}

function offerMemory() {
  if (!accepted?.memory?.length || !accepted.applied) return;
  ensureOverlay().proposeMemory(accepted.memory, location.host, accepted.suggestion.scope, accepted.applied);
  accepted.memory = undefined;
}

function followSuggestion(event: UiEvent) {
  if (!accepted) return;
  if (event.type === "start" && !accepted.runId && event.message === accepted.suggestion.text) accepted.runId = event.runId;
  if (event.type === "done" && event.runId === accepted.runId) {
    accepted.applied = event.applied.map((change) => change.id);
    offerMemory();
  }
}

// Undoing right after accepting a suggestion is the strongest "not this" signal the model gets.
function userRevert(id: string) {
  if (accepted && Date.now() - accepted.at < QUICK_UNDO_MS) {
    void recordFeedback({ text: accepted.suggestion.text, host: location.host, outcome: "undone" }).catch(() => undefined);
    accepted = null;
  }
  return revert(id);
}

async function syncLearnedText() {
  const { paused, profile } = await load();
  const changes = activeChanges();
  const current = changes.some(({ id }) => id === learnedTextScale.id);
  const hasExplicitScale = changes.some(({ id, block }) => id !== learnedTextScale.id && block?.name === "textScale");
  if (!paused && !hasExplicitScale && hasMemoryLine(profile, LARGER_TEXT)) {
    if (!current && (await applyChange(learnedTextScale, false)).ok) {
      recordChange(learnedTextScale.id, "Learned text preference applied locally (no LLM call)");
    }
  } else if (current) {
    await revertChange(learnedTextScale.id, false);
  }
}

async function restore() {
  if (detectInjectionFields(readInjectionSurface())) {
    const saved = await savedChangesFor(origin);
    const { paused, profile } = await load();
    if (saved.length || (!paused && hasMemoryLine(profile, LARGER_TEXT))) {
      recordActivity("Saved changes were not restored: this page tried to instruct the agent.");
    }
    return 0;
  }
  let restored = 0;
  for (const change of await savedChangesFor(origin, location.pathname)) {
    if ((await applyChange(change, false, { pageChecked: true })).ok) {
      // Counts what this page or site already has; a global change alone still lets the page-load run adapt here.
      if (change.scope !== "everywhere") restored++;
      recordChange(change.id, "Saved change restored locally (no LLM call)");
    } else recordActivity(`Saved change ${change.id} could not be restored.`);
  }
  await syncLearnedText();
  return restored;
}

function ensureOverlay(): OverlayUi {
  if (!overlay) {
    overlay = new OverlayUi({
    ask: (message, fresh, interrupt, thread, target) => void send({ kind: "runChat", message, fresh, interrupt, thread, target }),
    stop: () => void send({ kind: "stopRun" }),
    dequeue: (runId) => void send({ kind: "dequeue", runId }),
    clearTarget,
    pick: () => picker.start(),
    pointed,
    markTarget: (selector) => {
      const element = pointedElements.get(selector);
      if (element?.isConnected) markTarget(element);
    },
    listChanges: activeChanges,
    history: changeHistory,
    reapply: async (change) => void (await mutate(() => apply(change))),
    revert: async (id) => void (await userRevert(id)),
    revertAll: async () => {
      for (const change of activeChanges().reverse()) await userRevert(change.id);
    },
    acceptSuggestion: (suggestion) => void acceptSuggestion(suggestion).catch(reportExtensionError),
    dismissSuggestion: (suggestion) => void recordFeedback({ text: suggestion.text, host: location.host, outcome: "dismissed" }).catch(reportExtensionError),
    enableMicrophone: () => void send({ kind: "voiceOpenMic" }),
    openDebug: () => void send({ kind: "openDebug" }),
    readAloud: () => {
      if (!readPageAloud()) ensureOverlay().showToast("No readable text on this page.", [], true);
    },
    stopSpeaking: stopSpeech,
    isSpeaking: speechActive,
    ensureAlive,
    suggest: () => {
      const applied = activeChanges().map((change) => change.summary);
      const key = `${location.href}|${applied.join("|")}`;
      if (!suggestionCache.has(key)) {
        suggestionCache.set(key, send({ kind: "suggest", page: readPage(), applied }).then((result) => (result && typeof result === "object" ? (result as Suggestion) : null)));
      }
      return suggestionCache.get(key)!;
    },
    settings: {
      listChanges: async () => activeChanges(),
      revert: async (id) => void (await userRevert(id)),
      openDebug: () => void send({ kind: "openDebug" }),
      openShortcuts: () => void send({ kind: "openShortcuts" }),
      setKey: (provider, key, baseURL) => void send({ kind: "setKey", provider, key, ...(baseURL != null ? { baseURL } : {}) }),
      signIn: () => void send({ kind: "chatgptLogin" }),
      signOut: () => void send({ kind: "chatgptLogout" }),
      getStatus: async () => ((await send({ kind: "status" })) as StatusInfo | undefined) ?? { connected: false, busy: false },
    },
  });
    onFocusLive((on) => overlay?.setFocus(on));
    void load().then((state) => overlay?.setTheme(state.uiTheme));
  }
  return overlay;
}

async function handle(request: ContentRequest): Promise<unknown> {
  switch (request.kind) {
    case "prepareProfileSwitch":
      return mutate(async () => undefined);
    case "tool":
      switch (request.name) {
        case "read_page":
          return readPage();
        case "inspect":
          return inspect((request.input as { selector: string }).selector);
        case "list_items": {
          const input = request.input as { selector: string; keySelector: string | null };
          return listItems(input.selector, input.keySelector);
        }
        case "find_site_features":
          return findSiteFeatures();
        case "apply_change":
          return mutate(() => apply((request.input as { change: Change }).change, request.source === "recipe" ? "Saved recipe replayed locally (no LLM call)" : "Generated by LLM and applied by the local engine"));
        case "revert_change":
          return revert((request.input as { id: string }).id);
      }
      break;
    case "useSiteControl":
      return mutate(async () => {
        if ((await load()).paused) return { status: "unavailable", error: "Adaptations are paused." };
        const outcome = await applySiteControl(request.input, request.userMessage);
        if (outcome.status === "applied") recordChange(outcome.change.id, "Site control selected by the agent and executed locally");
        recordActivity(`Site control result: ${outcome.status}.`);
        return outcome;
      });
    case "activity":
      return recordActivity(request.text);
    case "inspectPage":
      return inspectPage();
    case "usage":
      return recordUsage(request.usage, request.model, request.purpose);
    case "list":
      return activeChanges() satisfies ActiveChange[];
    case "busy":
      return setBusy(request.on);
    case "frictionEvent":
      return onFriction(request.event);
    case "toast":
      return ensureOverlay().showToast(request.text, request.undoIds);
    case "readAloud":
      return readPageAloud();
    case "startVoice":
      return ensureOverlay().spotlight.startPointVoice();
    case "pickElement":
      overlay?.spotlight.hide();
      return picker.start();
    case "targetContextElement":
      if (lastContextElement?.isConnected) selectTarget(lastContextElement);
      return;
    case "toggleSpotlight":
      return ensureOverlay().spotlight.toggle();
    case "openSettings":
      return ensureOverlay().spotlight.openSettings();
    case "resetPage":
      overlay?.spotlight.hide();
      return revertAll();
    case "ui": {
      recordRun(request.event);
      const handled = (overlay ?? ensureOverlay()).handleEvent(request.event);
      followSuggestion(request.event);
      return handled;
    }
    case "voiceEvent":
      return overlay?.spotlight.handleVoice(request.event);
  }
}

const LOADED_FLAG = "__adaptiveAgentLoaded";

function start() {
  setFilterClassifier((match, items) => send({ kind: "classify", match, items }) as Promise<boolean[] | null>);
  // A filter that said it hid something but left matches on screen says so, once per rule per page.
  const toldLeftovers = new Set<string>();
  setLeftoverListener((filter, count) => {
    const change = activeChanges().find((active) => active.block?.name === "contentFilter" && active.block.keywords.join() === filter.keywords.join());
    const name = change?.summary ?? `Hide ${filter.keywords.join(", ")}`;
    const key = `${change?.id ?? filter.keywords.join()}|${location.href}`;
    if (toldLeftovers.has(key)) return;
    toldLeftovers.add(key);
    recordActivity(`${name}: ${count} still showing on this page.`);
    ensureOverlay().showToast(`${name}: ${count} still showing here.`, [], false, undefined, {
      label: "Fix it",
      run: async () => void send({ kind: "runChat", message: `${name} missed ${count} on this page. Hide the rest of the ${filter.keywords.join(", ")} here too.`, fresh: false }),
    });
  });
  // A reloaded extension leaves the previous instance's UI and styles behind; clear them before restoring.
  document.querySelectorAll('[data-ba="ui"], style[data-ba], svg[data-ba], label[data-ba]').forEach((node) => node.remove());
  onSpeechChange((on) => ensureOverlay().setSpeaking(on));

  chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
    Promise.resolve(handle(request))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  stopSensors = startSensors((kind) => void onFriction(kind).catch(() => undefined));
  addEventListener("pointermove", (event) => (mouseAt = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : mouseAt), { capture: true, passive: true });
  addEventListener("contextmenu", (event) => (lastContextElement = event.composedPath()[0] instanceof Element ? (event.composedPath()[0] as Element) : null), true);

  for (const type of KEY_EVENTS) {
    // Registered at document_start so these run before page scripts and keep page hotkeys from firing while the bar has focus.
    window.addEventListener(type, onKey, true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || tornDown) return;
    if (changes.uiTheme) overlay?.setTheme((changes.uiTheme.newValue as StoredState["uiTheme"] | undefined) ?? "dark");
    if (changes.activeProfileId || changes.configImportedAt) {
      accepted = null;
      suggestionCache.clear();
      clearTarget();
      setBusy(false);
      void mutate(async () => {
        await revertAll(false);
        clearChangeHistory();
        const state = await load();
        // A view transition waits for a frame, so a fast switch would keep the previous profile's rules on screen.
        const restored = state.paused ? 0 : await restore();
        await send({ kind: "pageReady", origin, restored, profileChanged: true });
      }).catch(reportExtensionError);
    } else if (changes.profile) void mutate(syncLearnedText).catch(() => undefined);
    if (changes.paused && !changes.configImportedAt) {
      recordActivity(changes.paused.newValue ? "Adaptations paused; reverting all active changes locally." : "Adaptations resumed; restoring saved changes locally.");
      void mutate(async () => {
        if (changes.paused.newValue) await revertAll();
        else await restore();
      }).catch(() => undefined);
    }
    if (changes.trackEvents) setEventTracking(changes.trackEvents.newValue !== false);
    if (changes.focusMode) setFocusMode(changes.focusMode.newValue === true);
    if (changes.floatingButton && document.body) ensureOverlay().setFab(Boolean(changes.floatingButton.newValue));
    if (changes.camera || changes.paused) void load().then((state) => whenReady(() => syncCamera(state.camera, state.paused)));
  });

  function whenReady(callback: () => void) {
    if (document.readyState !== "loading") callback();
    else addEventListener("DOMContentLoaded", callback, { once: true });
  }

  (async () => {
    const state = await load();
    setEventTracking(state.trackEvents);
    setFocusMode(state.focusMode);
    recordActivity(state.paused ? "Adaptations paused; saved changes were not restored." : "Restoring saved site and global changes locally.");
    whenReady(() => {
      if (state.floatingButton) ensureOverlay().setFab(true);
      void mutate(async () => {
        let restored = 0;
        try {
          if (!state.paused) restored = await restore();
        } finally {
          void send({ kind: "pageReady", origin, restored });
        }
      }).catch(reportExtensionError);
      syncCamera(state.camera, state.paused);
    });
  })().catch(reportExtensionError);
}

if (!(globalThis as Record<string, unknown>)[LOADED_FLAG]) {
  (globalThis as Record<string, unknown>)[LOADED_FLAG] = true;
  start();
}
