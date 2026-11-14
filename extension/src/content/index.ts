import { reportExtensionError } from "../extension-context.js";
import type { ActiveChange, Change } from "../../../shared/adaptation.js";
import type { BackgroundRequest, ContentRequest, ContentResponse, StatusInfo } from "../messages.js";
import { forgetLine, hasMemoryLine } from "../memory.js";
import { LARGER_TEXT, learnedTextScale } from "../zoom-preference.js";
import { OverlayUi } from "../overlay/ui.js";
import { load, recordApplied, recordReverted, savedChangesFor } from "../storage.js";
import { activeChanges, applyChange, applySiteControl, changeHistory, revertAll, revertChange, setBusy, stopEngine } from "./engine.js";
import { inspect, listItems, readPage } from "./outline.js";
import { findSiteFeatures } from "./site-controls.js";
import { speechActive, onSpeechChange, readPageAloud, stopSpeech } from "./speech.js";

const origin = location.origin;
let overlay: OverlayUi | null = null;
const suggestionCache = new Map<string, Promise<string | null>>();

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
    revert: async (id) => void (await revert(id)),
    revertAll: async () => {
      for (const change of activeChanges().reverse()) await revert(change.id);
    },
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
        suggestionCache.set(key, send({ kind: "suggest", page: readPage(), applied }).then((text) => (typeof text === "string" ? text : null)));
      }
      return suggestionCache.get(key)!;
    },
    settings: {
      listChanges: async () => activeChanges(),
      revert: async (id) => void (await revert(id)),
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
    case "frictionSaved":
      if (request.origin !== origin) return;
      return ensureOverlay().showToast("Remembered that you prefer larger text on every site.", [learnedTextScale.id]);
    case "frictionPrompt":
      if (request.origin !== origin) return;
      return ensureOverlay().showToast("Make text bigger on every site?", [], false, undefined, {
        label: "Yes, remember",
        run: async () => void (await send({ kind: "frictionAccept" })),
      });
    case "toast":
      return ensureOverlay().showToast(request.text, request.undoIds);
    case "readAloud":
      return readPageAloud();
    case "startVoice":
      return ensureOverlay().spotlight.startVoice();
    case "toggleSpotlight":
      return ensureOverlay().spotlight.toggle();
    case "ui":
      return overlay ? overlay.handleEvent(request.event) : ensureOverlay().handleEvent(request.event);
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
