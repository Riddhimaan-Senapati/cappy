import type { ActiveChange, ChatTurn } from "../../shared/adaptation.js";
import type { Routing, Tier } from "../../shared/protocol.js";

export interface Recipe {
  message: string;
  changes: ActiveChange[];
  at: number;
}

export interface StoredState {
  profile: string[];
  pendingMemory: string[];
  history: ChatTurn[];
  globalChanges: ActiveChange[];
  siteChanges: Record<string, ActiveChange[]>;
  recipes: Record<string, Recipe>;
  paused: boolean;
  proactive: boolean;
  floatingButton: boolean;
  routing: Routing;
  modelOverrides: Partial<Record<Tier, string>>;
  serverUrl: string;
  askBeforeRemember: boolean;
  speakReplies: boolean;
  ttsVoice: string;
  ttsRate: number;
  voiceAutoSend: boolean;
  voiceLang: string;
}

export const DEFAULTS: StoredState = {
  profile: [],
  pendingMemory: [],
  history: [],
  globalChanges: [],
  siteChanges: {},
  recipes: {},
  paused: false,
  proactive: true,
  floatingButton: true,
  routing: "auto",
  modelOverrides: {},
  serverUrl: "ws://localhost:8787/agent",
  askBeforeRemember: false,
  speakReplies: false,
  ttsVoice: "",
  ttsRate: 1,
  voiceAutoSend: true,
  voiceLang: "",
};

const MAX_RECIPES = 60;

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

export const recipeKey = (origin: string, message: string) => `${origin}::${message.trim().toLowerCase().replace(/\s+/g, " ")}`;

export async function saveRecipe(key: string, recipe: Recipe) {
  const { recipes } = await load();
  const next = { ...recipes, [key]: recipe };
  const keys = Object.keys(next).sort((a, b) => next[a].at - next[b].at);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_RECIPES))) delete next[old];
  await save({ recipes: next });
}
