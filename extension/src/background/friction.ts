import { acceptProposal, hasMemoryLine, rememberLines } from "../memory.js";
import { load } from "../storage.js";
import { sendToTab } from "./agent.js";

import { LARGER_TEXT } from "../zoom-preference.js";

const ZOOM_WINDOW_MS = 2 * 60 * 1000;

function zoomKey(tabId: number) {
  return `frictionZoom:${tabId}`;
}

export function registerFriction() {
  const queues = new Map<number, Promise<void>>();

  chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor, oldZoomFactor }) => {
    if (newZoomFactor <= oldZoomFactor) return;
    const now = Date.now();
    const next = (queues.get(tabId) ?? Promise.resolve())
      .then(() => recordZoomIn(tabId, now))
      .catch(() => undefined)
      .finally(() => {
        if (queues.get(tabId) === next) queues.delete(tabId);
      });
    queues.set(tabId, next);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void (queues.get(tabId) ?? Promise.resolve())
      .then(() => chrome.storage.session.remove(zoomKey(tabId)))
      .catch(() => undefined);
  });
}

async function recordZoomIn(tabId: number, now: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || !tab.url || !/^https?:\/\//.test(tab.url)) return;
  const { paused, profile, pendingMemory } = await load();
  if (paused || hasMemoryLine(profile, LARGER_TEXT) || hasMemoryLine(pendingMemory, LARGER_TEXT)) return;

  const origin = new URL(tab.url).origin;
  const key = zoomKey(tabId);
  const previous: unknown = (await chrome.storage.session.get(key))[key];
  const prefix = `${origin}|`;
  const then = typeof previous === "string" && previous.startsWith(prefix) ? Number(previous.slice(prefix.length)) : NaN;
  if (then <= now && now - then <= ZOOM_WINDOW_MS) {
    await chrome.storage.session.remove(key);
    const proposed = await rememberLines([LARGER_TEXT], { host: new URL(tab.url).host, scope: "everywhere" });
    if (proposed.length) await sendToTab(tabId, { kind: "frictionPrompt", origin });
  } else {
    await chrome.storage.session.set({ [key]: `${prefix}${now}` });
  }
}

// The prompt asks about every site, so accepting saves it everywhere and confirms with an Undo.
export async function acceptFriction(tab: chrome.tabs.Tab) {
  const { paused, pendingMemory } = await load();
  if (paused || !hasMemoryLine(pendingMemory, LARGER_TEXT)) return;
  await acceptProposal(LARGER_TEXT, "everywhere");
  if (tab.id !== undefined && tab.url) await sendToTab(tab.id, { kind: "frictionSaved", origin: new URL(tab.url).origin }).catch(() => undefined);
}
