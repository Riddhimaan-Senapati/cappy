import type { ActiveChange, ChatTurn } from "../../shared/adaptation.js";
import type { Routing, Tier } from "../../shared/protocol.js";

export interface Recipe {
  message: string;
  changes: ActiveChange[];
  at: number;
}

export interface SavedCommand {
  id: string;
  name: string;
  prompt: string;
  everywhere: boolean;
  appliedOrigins: string[];
  createdAt: number;
}

export interface CameraSettings {
  enabled: boolean;
  handScroll: boolean;
  headScroll: boolean;
  pointer: boolean;
  dwellMs: number;
}

export interface StoredState {
  profile: string[];
  history: ChatTurn[];
  globalChanges: ActiveChange[];
  siteChanges: Record<string, ActiveChange[]>;
  recipes: Record<string, Recipe>;
  commands: SavedCommand[];
  camera: CameraSettings;
  paused: boolean;
  proactive: boolean;
  floatingButton: boolean;
  routing: Routing;
  provider: string | null;
  modelChoices: Record<string, Partial<Record<Tier, string>>>;
  serverUrl: string;
}

export const DEFAULTS: StoredState = {
  profile: [],
  history: [],
  globalChanges: [],
  siteChanges: {},
  recipes: {},
  commands: [],
  camera: { enabled: false, handScroll: true, headScroll: false, pointer: true, dwellMs: 0 },
  paused: false,
  proactive: true,
  floatingButton: true,
  routing: "fast",
  provider: null,
  modelChoices: {},
  serverUrl: "ws://localhost:8787/agent",
};

const MAX_RECIPES = 60;

// A content script left behind by a reloaded extension loses access to chrome.*; treat that as empty, not as a crash.
export async function load(): Promise<StoredState> {
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored } as StoredState;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function save(patch: Partial<StoredState>) {
  try {
    await chrome.storage.local.set(patch);
  } catch {
    // extension was reloaded; the new instance owns storage now
  }
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
