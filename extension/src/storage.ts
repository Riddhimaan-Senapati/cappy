import Fuse from "fuse.js";
import type { ActiveChange, ChatTurn } from "../../shared/adaptation.js";
import type { Routing, Tier } from "../../shared/protocol.js";

export interface Recipe {
  message: string;
  changes: ActiveChange[];
  at: number;
}

export interface RequestSession {
  message: string;
  reply: string;
  outcome: "done" | "error";
  thread?: string;
}

export interface StoredState {
  profile: string[];
  pendingMemory: string[];
  history: ChatTurn[];
  submittedRequests: string[];
  requestSessions: RequestSession[];
  globalChanges: ActiveChange[];
  siteChanges: Record<string, ActiveChange[]>;
  recipes: Record<string, Recipe>;
  paused: boolean;
  proactive: boolean;
  floatingButton: boolean;
  routing: Routing;
  modelOverrides: Partial<Record<Tier, string>>;
  modelOverrideProvider: string;
  serverUrl: string;
  askBeforeRemember: boolean;
  speakReplies: boolean;
  ttsVoice: string;
  ttsRate: number;
  voiceAutoSend: boolean;
  voiceLang: string;
  voiceProvider: "chrome" | "openai" | "gemini";
  openAIVoiceVerified: boolean;
  geminiVoiceVerified: boolean;
}

export const DEFAULTS: StoredState = {
  profile: [],
  pendingMemory: [],
  history: [],
  submittedRequests: [],
  requestSessions: [],
  globalChanges: [],
  siteChanges: {},
  recipes: {},
  paused: false,
  proactive: true,
  floatingButton: true,
  routing: "auto",
  modelOverrides: {},
  modelOverrideProvider: "",
  serverUrl: "ws://localhost:8787/agent",
  askBeforeRemember: false,
  speakReplies: false,
  ttsVoice: "",
  ttsRate: 1,
  voiceAutoSend: true,
  voiceLang: "",
  voiceProvider: "chrome",
  openAIVoiceVerified: false,
  geminiVoiceVerified: false,
};

const MAX_RECIPES = 60;

export async function load(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const state = { ...DEFAULTS, ...stored } as StoredState;
  if ((state.voiceProvider === "openai" && !state.openAIVoiceVerified) || (state.voiceProvider === "gemini" && !state.geminiVoiceVerified)) state.voiceProvider = "chrome";
  return state;
}

export async function save(patch: Partial<StoredState>) {
  await chrome.storage.local.set(patch);
}

function requestHistory(state: Pick<StoredState, "history" | "submittedRequests">): string[] {
  return state.submittedRequests.length
    ? state.submittedRequests
    : state.history.filter((turn) => turn.role === "user").map((turn) => turn.text);
}

let requestWrite: Promise<void> = Promise.resolve();

function updateRequestHistory(update: (state: StoredState) => Partial<StoredState>) {
  const write = requestWrite.then(async () => save(update(await load())));
  requestWrite = write.catch(() => undefined);
  return write;
}

export function recordSubmittedRequest(message: string) {
  return updateRequestHistory((state) => ({ submittedRequests: [...requestHistory(state), message] }));
}

export function recordRequestSession(session: RequestSession) {
  return updateRequestHistory((state) => {
    if (!requestHistory(state).some((request) => normalizeRequest(request) === normalizeRequest(session.message))) return {};
    return { requestSessions: [...state.requestSessions, session] };
  });
}

export function findRequestSessions(state: StoredState, message: string): RequestSession[] {
  const target = normalizeRequest(message);
  const sessions = state.requestSessions.filter((session) => normalizeRequest(session.thread ?? session.message) === target);
  if (sessions.length) return sessions;
  const index = state.history.findLastIndex((turn) => turn.role === "user" && normalizeRequest(turn.text) === target);
  const next = state.history[index + 1];
  return index >= 0 && next?.role === "assistant" ? [{ message, reply: next.text, outcome: "done" }] : [];
}

const normalizeRequest = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export function removeSubmittedRequest(message: string): Promise<void> {
  const target = normalizeRequest(message);
  return updateRequestHistory((state) => ({
    submittedRequests: requestHistory(state).filter((request) => normalizeRequest(request) !== target),
    history: state.history.filter((turn) => turn.role !== "user" || normalizeRequest(turn.text) !== target),
    requestSessions: state.requestSessions.filter((session) => normalizeRequest(session.thread ?? session.message) !== target && normalizeRequest(session.message) !== target),
  }));
}

export async function deleteRequest(message: string) {
  const response = await chrome.runtime.sendMessage({ kind: "deleteRequest", message });
  if (!response?.ok) throw new Error("Could not delete the saved request.");
}

export function suggestRequests(state: Pick<StoredState, "history" | "submittedRequests">, input: string): string[] {
  const query = normalizeRequest(input);
  if (!query) return [];
  const seen = new Set([query]);
  const requests = requestHistory(state).slice().reverse().filter((request) => {
    const normalized = normalizeRequest(request);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  const search = new Fuse(requests, { threshold: 0.3, ignoreLocation: true });
  return search.search(query, { limit: 5 }).map(({ item }) => item);
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
