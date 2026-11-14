import type { ActiveChange, Change } from "../../../shared/adaptation.js";
import type { BackgroundRequest, ContentRequest, ContentResponse, StatusInfo } from "../messages.js";
import { OverlayUi } from "../overlay/ui.js";
import { load, recordApplied, recordReverted, savedChangesFor } from "../storage.js";
import { activeChanges, applyChange, changeHistory, revertAll, revertChange, setBusy, stopEngine } from "./engine.js";
import { inspect, listItems, readPage } from "./outline.js";

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
    return chrome.runtime.sendMessage(request).catch(() => undefined);
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

async function apply(change: Change) {
  const outcome = await applyChange(change);
  const stored = activeChanges().find((active) => active.id === change.id);
  if (outcome.ok && stored) await recordApplied(origin, stored);
  for (const id of outcome.replaced ?? []) await recordReverted(origin, id);
  return outcome;
}

async function revert(id: string) {
  const ok = await revertChange(id);
  await recordReverted(origin, id);
  return { ok };
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
    history: changeHistory,
    reapply: async (change) => void (await apply(change)),
    revert: async (id) => void (await revert(id)),
    revertAll: async () => {
      for (const change of activeChanges()) await revert(change.id);
    },
    openDebug: () => void send({ kind: "openDebug" }),
    ensureAlive,
    suggest: () => {
      const applied = activeChanges().map((change) => change.summary);
      const key = `${location.href}|${applied.join("|")}`;
      if (!suggestionCache.has(key)) {
        suggestionCache.set(key, send({ kind: "suggest", page: readPage(), applied }).then((text) => (typeof text === "string" ? text : null)));
      }
      return suggestionCache.get(key)!;
    },
    stop: () => void send({ kind: "stopRun" }),
    dequeue: (runId) => void send({ kind: "dequeue", runId }),
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
        case "apply_change":
          return apply((request.input as { change: Change }).change);
        case "revert_change":
          return revert((request.input as { id: string }).id);
      }
      break;
    case "list":
      return activeChanges() satisfies ActiveChange[];
    case "busy":
      return setBusy(request.on);
    case "toast":
      return ensureOverlay().showToast(request.text, request.undoIds);
    case "toggleSpotlight":
      return ensureOverlay().spotlight.toggle();
    case "ui":
      return overlay ? overlay.handleEvent(request.event) : ensureOverlay().handleEvent(request.event);
  }
}

const LOADED_FLAG = "__adaptiveAgentLoaded";

function start() {
  // A reloaded extension leaves the previous instance's UI and styles behind; clear them before restoring.
  document.querySelectorAll('[data-ba="ui"], style[data-ba], svg[data-ba], label[data-ba]').forEach((node) => node.remove());

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
    if (area !== "local") return;
    if (changes.paused) {
      if (changes.paused.newValue) void revertAll();
      else void restore(true);
    }
    if (changes.floatingButton && document.body) ensureOverlay().setFab(Boolean(changes.floatingButton.newValue));
  });

  function whenReady(callback: () => void) {
    if (document.readyState !== "loading") callback();
    else addEventListener("DOMContentLoaded", callback, { once: true });
  }

  (async () => {
    const state = await load();
    const restored = state.paused ? 0 : await restore(false);
    whenReady(() => {
      void send({ kind: "pageReady", origin, restored });
      if (state.floatingButton) ensureOverlay().setFab(true);
    });
  })();
}

if (!(globalThis as Record<string, unknown>)[LOADED_FLAG]) {
  (globalThis as Record<string, unknown>)[LOADED_FLAG] = true;
  start();
}
