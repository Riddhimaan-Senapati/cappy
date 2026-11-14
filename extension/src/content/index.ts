import { reportExtensionError } from "../extension-context.js";
import type { ActiveChange, Change } from "../../../shared/adaptation.js";
import type { FrictionKind, Suggestion } from "../../../shared/protocol.js";
import { recordFeedback } from "../feedback.js";
import { recordFriction } from "../friction-log.js";
import { startSensors } from "./sensors.js";
import type { BackgroundRequest, ContentRequest, ContentResponse, StatusInfo, UiEvent } from "../messages.js";
import { forgetLine, hasMemoryLine, rememberLines } from "../memory.js";
import { LARGER_TEXT, learnedTextScale } from "../zoom-preference.js";
import { OverlayUi } from "../overlay/ui.js";
import { load, recordApplied, recordReverted, savedChangesFor } from "../storage.js";
import { activeChanges, applyChange, applySiteControl, changeHistory, revertAll, revertChange, setBusy, stopEngine } from "./engine.js";
import { inspect, listItems, readPage } from "./outline.js";
import { findSiteFeatures } from "./site-controls.js";
import { speechActive, onSpeechChange, readPageAloud, stopSpeech } from "./speech.js";

const origin = location.origin;
let overlay: OverlayUi | null = null;
const suggestionCache = new Map<string, Promise<Suggestion | null>>();
const QUICK_UNDO_MS = 30_000;
// Tracks the latest accepted suggestion: its run, the memory line to offer, and when it finished.
let accepted: { suggestion: Suggestion; at: number; runId?: string; memory?: string[]; applied?: string[] } | null = null;
let stopSensors: (() => void) | null = null;

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
  stopEngine();
  stopSensors?.();
  for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
}

const ensureAlive = () => alive() || (teardown(), false);

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

async function apply(change: Change) {
  if (change.block?.name === "textScale" && change.id !== learnedTextScale.id) {
    await revertChange(learnedTextScale.id, false);
  }
  const outcome = await applyChange(change);
  const stored = activeChanges().find((active) => active.id === change.id);
  if (outcome.ok && stored) await recordApplied(origin, stored);
  for (const id of outcome.replaced ?? []) await recordReverted(origin, id);
  if (change.block?.name === "textScale") await syncLearnedText();
  return outcome;
}

function revert(id: string) {
  return mutate(async () => {
    const wasTextScale = activeChanges().some((change) => change.id === id && change.block?.name === "textScale");
    const ok = await revertChange(id);
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
    if (!current) await applyChange(learnedTextScale, false);
  } else if (current) {
    await revertChange(learnedTextScale.id, false);
  }
}

async function restore(animate: boolean) {
  let restored = 0;
  for (const change of await savedChangesFor(origin)) {
    if ((await applyChange(change, animate)).ok) restored++;
  }
  await syncLearnedText();
  return restored;
}

function ensureOverlay(): OverlayUi {
  overlay ??= new OverlayUi({
    ask: (message, fresh, interrupt, thread) => void send({ kind: "runChat", message, fresh, interrupt, thread }),
    stop: () => void send({ kind: "stopRun" }),
    dequeue: (runId) => void send({ kind: "dequeue", runId }),
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
      setKey: (provider, key) => void send({ kind: "setKey", provider, key }),
      signIn: () => void send({ kind: "chatgptLogin" }),
      signOut: () => void send({ kind: "chatgptLogout" }),
      getStatus: async () => ((await send({ kind: "status" })) as StatusInfo | undefined) ?? { connected: false, busy: false },
    },
  });
  return overlay;
}

async function handle(request: ContentRequest): Promise<unknown> {
  switch (request.kind) {
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
          return mutate(() => apply((request.input as { change: Change }).change));
        case "revert_change":
          return revert((request.input as { id: string }).id);
      }
      break;
    case "useSiteControl":
      return mutate(async () => {
        if ((await load()).paused) return { status: "unavailable", error: "Adaptations are paused." };
        return applySiteControl(request.input, request.userMessage);
      });
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
      return ensureOverlay().spotlight.startVoice();
    case "toggleSpotlight":
      return ensureOverlay().spotlight.toggle();
    case "ui": {
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

  for (const type of KEY_EVENTS) {
    // Registered at document_start so these run before page scripts and keep page hotkeys from firing while the bar has focus.
    window.addEventListener(type, onKey, true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || tornDown) return;
    if (changes.profile) void mutate(syncLearnedText).catch(() => undefined);
    if (changes.paused) {
      void mutate(async () => {
        if (changes.paused.newValue) await revertAll();
        else await restore(true);
      }).catch(() => undefined);
    }
    if (changes.floatingButton && document.body) ensureOverlay().setFab(Boolean(changes.floatingButton.newValue));
  });

  function whenReady(callback: () => void) {
    if (document.readyState !== "loading") callback();
    else addEventListener("DOMContentLoaded", callback, { once: true });
  }

  (async () => {
    const state = await load();
    whenReady(() => {
      if (state.floatingButton) ensureOverlay().setFab(true);
      void mutate(async () => {
        let restored = 0;
        try {
          if (!state.paused) restored = await restore(false);
        } finally {
          void send({ kind: "pageReady", origin, restored });
        }
      }).catch(reportExtensionError);
    });
  })().catch(reportExtensionError);
}

if (!(globalThis as Record<string, unknown>)[LOADED_FLAG]) {
  (globalThis as Record<string, unknown>)[LOADED_FLAG] = true;
  start();
}
