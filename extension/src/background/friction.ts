import { acceptProposal, hasMemoryLine } from "../memory.js";
import { load } from "../storage.js";
import { type AgentClient, sendToTab } from "./agent.js";

const ZOOM_WINDOW_MS = 2 * 60 * 1000;
const LARGER_TEXT = "Prefers larger text";

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
  const { paused, profile } = await load();
  if (paused || hasMemoryLine(profile, LARGER_TEXT)) return;

  const origin = new URL(tab.url).origin;
  const key = zoomKey(tabId);
  const previous: unknown = (await chrome.storage.session.get(key))[key];
  const prefix = `${origin}|`;
  const then = typeof previous === "string" && previous.startsWith(prefix) ? Number(previous.slice(prefix.length)) : NaN;
  if (then <= now && now - then <= ZOOM_WINDOW_MS) {
    await chrome.storage.session.remove(key);
    await sendToTab(tabId, { kind: "frictionPrompt", origin });
  } else {
    await chrome.storage.session.set({ [key]: `${prefix}${now}` });
  }
}

export async function acceptFriction(tab: chrome.tabs.Tab, agent: AgentClient) {
  if ((await load()).paused) return;
  await acceptProposal(LARGER_TEXT);
  await agent.startRun(tab, "page_load", "");
}
