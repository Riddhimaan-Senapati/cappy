import type { ActiveChange, Change } from "../../../shared/adaptation.js";
import type { BackgroundRequest, ContentRequest, ContentResponse, StatusInfo } from "../messages.js";
import { OverlayUi } from "../overlay/ui.js";
import { load, recordApplied, recordReverted, savedChangesFor } from "../storage.js";
import { activeChanges, applyChange, applySiteControl, revertAll, revertChange, setBusy } from "./engine.js";
import { inspect, readPage } from "./outline.js";
import { findSiteFeatures } from "./site-controls.js";
import { speechActive, onSpeechChange, readPageAloud, stopSpeech } from "./speech.js";

const origin = location.origin;
let overlay: OverlayUi | null = null;
onSpeechChange((on) => ensureOverlay().setSpeaking(on));

let pendingMutation: Promise<unknown> = Promise.resolve();

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(operation);
  pendingMutation = result.catch(() => undefined);
  return result;
}

const send = (request: BackgroundRequest) => chrome.runtime.sendMessage(request).catch(() => undefined);

async function apply(change: Change) {
  const outcome = await applyChange(change);
  const stored = activeChanges().find((active) => active.id === change.id);
  if (outcome.ok && stored) await recordApplied(origin, stored);
  return outcome;
}

function revert(id: string) {
  return mutate(async () => {
    const ok = await revertChange(id);
    if (id.startsWith("site-control-")) {
      if (!ok) ensureOverlay().showToast("The site control could not be restored.", [], true);
    } else {
      await recordReverted(origin, id);
    }
    return { ok };
  });
}

async function restore(animate: boolean) {
  let restored = 0;
  for (const change of await savedChangesFor(origin)) {
    if ((await applyChange(change, animate)).ok) restored++;
  }
  return restored;
}

function ensureOverlay(): OverlayUi {
  overlay ??= new OverlayUi({
    ask: (message, fresh) => void send({ kind: "runChat", message, fresh }),
    listChanges: activeChanges,
    revert: async (id) => void (await revert(id)),
    revertAll: async () => {
      for (const change of activeChanges().reverse()) await revert(change.id);
    },
    openDebug: () => void send({ kind: "openDebug" }),
    readAloud: () => {
      if (!readPageAloud()) ensureOverlay().showToast("No readable text on this page.", [], true);
    },
    stopSpeaking: stopSpeech,
    isSpeaking: speechActive,
    settings: {
      listChanges: async () => activeChanges(),
      revert: async (id) => void (await revert(id)),
      openDebug: () => void send({ kind: "openDebug" }),
      openShortcuts: () => void send({ kind: "openShortcuts" }),
      getStatus: async () => ((await chrome.runtime.sendMessage({ kind: "status" } satisfies BackgroundRequest)) as StatusInfo) ?? { connected: false, busy: false },
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
    case "toggleSpotlight":
      return ensureOverlay().spotlight.toggle();
    case "ui":
      return overlay ? overlay.handleEvent(request.event) : ensureOverlay().handleEvent(request.event);
    case "voiceEvent":
      return overlay?.spotlight.handleVoice(request.event);
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
  Promise.resolve(handle(request))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

for (const type of ["keydown", "keyup", "keypress"] as const) {
  // Registered at document_start so these run before page scripts and keep page hotkeys from firing while the bar has focus.
  window.addEventListener(type, (event) => overlay?.captureKey(event), true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
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
  const restored = state.paused ? 0 : await mutate(() => restore(false));
  whenReady(() => {
    void send({ kind: "pageReady", origin, restored });
    if (state.floatingButton) ensureOverlay().setFab(true);
  });
})();
