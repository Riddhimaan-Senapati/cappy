import type { Change } from "../../../shared/adaptation.js";
import type { ContentEvent, ContentRequest, ContentResponse } from "../messages.js";
import { load, recordApplied, recordReverted, savedChangesFor } from "../storage.js";
import { OWN_ATTR } from "./dom.js";
import { activeChanges, applyChange, revertAll, revertChange, setBusy } from "./engine.js";
import { inspect, readPage } from "./outline.js";

const origin = location.origin;

const notify = (event: ContentEvent) => chrome.runtime.sendMessage(event).catch(() => undefined);

async function apply(change: Change) {
  const outcome = await applyChange(change);
  const stored = activeChanges().find((active) => active.id === change.id);
  if (outcome.ok && stored) await recordApplied(origin, stored);
  notify({ kind: "changesUpdated", origin });
  return outcome;
}

async function revert(id: string) {
  const ok = await revertChange(id);
  await recordReverted(origin, id);
  notify({ kind: "changesUpdated", origin });
  return { ok };
}

async function handle(request: ContentRequest): Promise<unknown> {
  switch (request.kind) {
    case "tool":
      switch (request.name) {
        case "read_page":
          return readPage();
        case "inspect":
          return inspect((request.input as { selector: string }).selector);
        case "apply_change":
          return apply((request.input as { change: Change }).change);
        case "revert_change":
          return revert((request.input as { id: string }).id);
      }
      break;
    case "list":
      return activeChanges();
    case "busy":
      return setBusy(request.on);
    case "toast":
      return showToast(request.text, request.undoIds);
    case "pause":
      if (request.paused) await revertAll();
      else await restore(true);
      notify({ kind: "changesUpdated", origin });
      return true;
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
  handle(request)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function restore(animate: boolean) {
  let restored = 0;
  for (const change of await savedChangesFor(origin)) {
    const outcome = await applyChange(change, animate);
    if (outcome.ok) restored++;
  }
  return restored;
}

function showToast(text: string, undoIds: string[]) {
  document.querySelector(`[${OWN_ATTR}="toast"]`)?.remove();
  const host = document.createElement("div");
  host.setAttribute(OWN_ATTR, "toast");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .toast { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; max-width: 360px; display: flex; gap: 12px; align-items: flex-start;
        background: #111827; color: #f9fafb; font: 14px/1.4 system-ui, sans-serif; padding: 14px 16px; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.3); animation: in .35s cubic-bezier(.2,.9,.3,1.2); }
      @keyframes in { from { transform: translateY(16px); opacity: 0; } }
      .text { flex: 1; }
      button { all: unset; cursor: pointer; font-weight: 600; color: #93c5fd; padding: 2px 4px; border-radius: 4px; }
      button:focus-visible { outline: 2px solid #93c5fd; }
    </style>
    <div class="toast" role="status"><span class="text"></span><button class="undo">Undo</button><button class="close" aria-label="Dismiss">✕</button></div>`;
  shadow.querySelector(".text")!.textContent = text;
  shadow.querySelector(".undo")!.addEventListener("click", async () => {
    for (const id of undoIds) await revert(id);
    host.remove();
  });
  shadow.querySelector(".close")!.addEventListener("click", () => host.remove());
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 12_000);
}

(async () => {
  const state = await load();
  const restored = state.paused ? 0 : await restore(false);
  notify({ kind: "pageReady", origin, restored });
})();
