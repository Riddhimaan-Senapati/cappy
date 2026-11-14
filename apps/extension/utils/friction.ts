import { FrictionEvent } from "@browser-agent/shared";
import { z } from "zod";
import { readParsed } from "./state";

export const FRICTION_KEY = "friction";
export const FRICTION_WINDOW_MS = 2 * 60 * 1000;
const ZOOM_IN_THRESHOLD = 2;
const MAX_EVENTS_PER_HOST = 20;

export const FrictionMap = z.record(z.string(), z.array(FrictionEvent));
export type FrictionMap = z.infer<typeof FrictionMap>;

export function appendEvent(events: FrictionEvent[], event: FrictionEvent, now: number): FrictionEvent[] {
  return [...events, event].filter((e) => now - e.at <= FRICTION_WINDOW_MS && e.at <= now).slice(-MAX_EVENTS_PER_HOST);
}

export function shouldPrompt(events: FrictionEvent[], now: number): boolean {
  const zoomIns = events.filter(
    (e) => e.kind === "zoom_in" && now - e.at <= FRICTION_WINDOW_MS && e.at <= now,
  );
  return zoomIns.length >= ZOOM_IN_THRESHOLD;
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? hostname : undefined;
  } catch {
    return undefined;
  }
}

export function startFriction(onPrompt: (tabId: number) => Promise<void>): void {
  chrome.tabs.onZoomChange.addListener((info) => {
    if (info.newZoomFactor <= info.oldZoomFactor) return;
    void handleZoomIn(info.tabId, onPrompt).catch((err: unknown) => {
      console.warn("friction tracking failed", err);
    });
  });
}

async function handleZoomIn(tabId: number, onPrompt: (tabId: number) => Promise<void>): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const host = hostOf(tab?.url);
  if (!host) return;

  const now = Date.now();
  const map: FrictionMap = (await readParsed("session", FRICTION_KEY, FrictionMap)) ?? {};
  const events = appendEvent(map[host] ?? [], { kind: "zoom_in", host, at: now }, now);
  const prompt = shouldPrompt(events, now);
  map[host] = prompt ? [] : events;
  await chrome.storage.session.set({ [FRICTION_KEY]: map });
  if (prompt) await onPrompt(tabId);
}
