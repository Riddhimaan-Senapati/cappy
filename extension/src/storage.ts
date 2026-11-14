import type { ActiveChange, ChatTurn } from "../../shared/adaptation.js";

export interface StoredState {
  profile: string[];
  history: ChatTurn[];
  globalChanges: ActiveChange[];
  siteChanges: Record<string, ActiveChange[]>;
  paused: boolean;
  proactive: boolean;
  serverUrl: string;
}

const DEFAULTS: StoredState = {
  profile: [],
  history: [],
  globalChanges: [],
  siteChanges: {},
  paused: false,
  proactive: true,
  serverUrl: "ws://localhost:8787/agent",
};

export async function load(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored } as StoredState;
}

export async function save(patch: Partial<StoredState>) {
  await chrome.storage.local.set(patch);
}

export async function savedChangesFor(origin: string): Promise<ActiveChange[]> {
  const state = await load();
  return [...state.globalChanges, ...(state.siteChanges[origin] ?? [])];
}

const without = (changes: ActiveChange[], id: string) => changes.filter((change) => change.id !== id);

export async function recordApplied(origin: string, change: ActiveChange) {
  const state = await load();
  const site = without(state.siteChanges[origin] ?? [], change.id);
  const globalChanges = without(state.globalChanges, change.id);
  if (change.scope === "everywhere") globalChanges.push(change);
  else site.push(change);
  await save({ globalChanges, siteChanges: { ...state.siteChanges, [origin]: site } });
}

export async function recordReverted(origin: string, id: string) {
  const state = await load();
  await save({
    globalChanges: without(state.globalChanges, id),
    siteChanges: { ...state.siteChanges, [origin]: without(state.siteChanges[origin] ?? [], id) },
  });
}
