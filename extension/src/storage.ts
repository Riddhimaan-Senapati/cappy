import Fuse from "fuse.js";
import type { ActiveChange, ChatTurn } from "../../shared/adaptation.js";
import type { FrictionKind, MemoryScope, ChoiceOption, Routing, SuggestionFeedback, Tier, TokenUsage } from "../../shared/protocol.js";
import { savedChangeOnThisPage } from "../../shared/validate.js";

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
  options?: { question: string; options: ChoiceOption[] };
}

export interface PendingSite {
  host: string;
  scope: MemoryScope;
}

export type FrictionCounts = Partial<Record<FrictionKind, number>>;

// Counts per bucket start, then per host. Kept small on purpose: no raw events beyond the last two minutes.
export interface ActivityStats {
  buckets: Record<string, Record<string, FrictionCounts>>;
  totals: Record<string, FrictionCounts>;
}

export interface FrictionEntry {
  host: string;
  kind: FrictionKind;
  at: number;
}

export interface SiteSkill {
  notes: string[];
  updatedAt: number;
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
  swipeNav?: boolean;
  speakAfterSelect?: boolean;
  dwellMs: number;
}

export interface StoredState {
  activeProfileId: string;
  profiles: Record<string, { name: string; state?: ProfileState }>;
  usage: TokenUsage;
  profile: string[];
  pendingMemory: string[];
  pendingSites: Record<string, PendingSite>;
  siteSkills: Record<string, SiteSkill>;
  frictionLog: FrictionEntry[];
  activity: ActivityStats;
  nudgedAt: Record<string, number>;
  suggestionFeedback: SuggestionFeedback[];
  history: ChatTurn[];
  submittedRequests: string[];
  lastingSuggestion: string | null;
  requestSessions: RequestSession[];
  globalChanges: ActiveChange[];
  siteChanges: Record<string, ActiveChange[]>;
  recipes: Record<string, Recipe>;
  commands: SavedCommand[];
  camera: CameraSettings;
  paused: boolean;
  proactive: boolean;
  askBeforeAdapting: boolean;
  floatingButton: boolean;
  trackEvents: boolean;
  focusMode: boolean;
  routing: Routing;
  provider: string | null;
  modelChoices: Record<string, Partial<Record<Tier, string>>>;
  serverUrl: string;
  speakReplies: boolean;
  ttsVoice: string;
  ttsRate: number;
  voiceAutoSend: boolean;
  voiceLang: string;
  voiceProvider: "chrome" | "openai" | "gemini";
  openAIVoiceVerified: boolean;
  geminiVoiceVerified: boolean;
  onboarded: boolean;
  uiTheme: "dark" | "light" | "system";
  barOffset: { x: number; y: number } | null;
}

export const PROFILE_KEYS = ["profile", "pendingMemory", "pendingSites", "history", "submittedRequests", "requestSessions", "lastingSuggestion", "globalChanges", "siteChanges", "recipes", "commands", "nudgedAt", "suggestionFeedback"] as const;
export type ProfileState = Pick<StoredState, typeof PROFILE_KEYS[number]>;

export const DEFAULTS: StoredState = {
  activeProfileId: "default",
  profiles: { default: { name: "Default" } },
  usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  profile: [],
  pendingMemory: [],
  pendingSites: {},
  siteSkills: {},
  frictionLog: [],
  activity: { buckets: {}, totals: {} },
  nudgedAt: {},
  suggestionFeedback: [],
  history: [],
  submittedRequests: [],
  lastingSuggestion: null,
  requestSessions: [],
  globalChanges: [],
  siteChanges: {},
  recipes: {},
  commands: [],
  camera: { enabled: false, handScroll: true, headScroll: false, pointer: true, swipeNav: true, dwellMs: 0 },
  paused: false,
  proactive: true,
  askBeforeAdapting: true,
  floatingButton: true,
  trackEvents: true,
  focusMode: false,
  routing: "auto",
  provider: null,
  modelChoices: {},
  serverUrl: "ws://localhost:8787/agent",
  speakReplies: false,
  ttsVoice: "",
  ttsRate: 1,
  voiceAutoSend: true,
  voiceLang: "",
  voiceProvider: "chrome",
  openAIVoiceVerified: false,
  geminiVoiceVerified: false,
  onboarded: false,
  uiTheme: "dark",
  barOffset: null,
};

const MAX_RECIPES = 60;
const MAX_SITE_NOTES = 20;
const MAX_SKILL_SITES = 100;

// Newest notes win when a site fills up, and the least recently updated sites drop off first.
export async function saveSiteNotes(host: string, notes: string[]) {
  const { siteSkills } = await load();
  const key = host.toLowerCase();
  const existing = siteSkills[key]?.notes ?? [];
  const known = new Set(existing.map((note) => note.toLowerCase()));
  const merged = [...existing, ...notes.filter((note) => !known.has(note.toLowerCase()))].slice(-MAX_SITE_NOTES);
  const next = { ...siteSkills, [key]: { notes: merged, updatedAt: Date.now() } };
  const hosts = Object.keys(next).sort((a, b) => next[a].updatedAt - next[b].updatedAt);
  for (const old of hosts.slice(0, Math.max(0, hosts.length - MAX_SKILL_SITES))) delete next[old];
  await save({ siteSkills: next });
}

export async function forgetSiteNotes(host: string) {
  const { siteSkills } = await load();
  const next = { ...siteSkills };
  delete next[host.toLowerCase()];
  await save({ siteSkills: next });
}

// A content script left behind by a reloaded extension loses access to chrome.*; treat that as empty, not as a crash.
export async function load(): Promise<StoredState> {
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const state = { ...DEFAULTS, ...stored } as StoredState;
    if ((state.voiceProvider === "openai" && !state.openAIVoiceVerified) || (state.voiceProvider === "gemini" && !state.geminiVoiceVerified)) state.voiceProvider = "chrome";
    return state;
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

export async function savedChangesFor(origin: string, pathname?: string): Promise<ActiveChange[]> {
  const state = await load();
  const fits = (change: ActiveChange) => pathname === undefined || savedChangeOnThisPage(change, pathname);
  return [...state.globalChanges.filter(fits), ...(state.siteChanges[origin] ?? []).filter(fits)];
}

const without = (changes: ActiveChange[], id: string) => changes.filter((change) => change.id !== id);

function writeSite(siteChanges: Record<string, ActiveChange[]>, origin: string, site: ActiveChange[]) {
  const next = { ...siteChanges };
  if (site.length) next[origin] = site;
  else delete next[origin];
  return next;
}

type StoredScope = "page" | "site" | "everywhere";

function portableChange(change: ActiveChange): boolean {
  if (change.css || change.dom?.length) return false;
  return !(change.block?.name === "contentFilter" && change.block.itemSelector);
}

// A weekday rule or a host selector was asked for this site. "Don't save" must not shrink it to one page.
function anchoredChange(change: ActiveChange): boolean {
  if (change.schedule != null) return true;
  if (change.block?.name === "contentFilter" && change.block.itemSelector) return true;
  return change.scope === "site";
}

// "hold" runs when the prompt appears: an all-sites preference waits on this page until the user accepts.
export function scopeForPrompt(change: ActiveChange, answer: "hold" | "site" | "everywhere"): StoredScope | null {
  if (answer === "hold") return !anchoredChange(change) && change.scope === "everywhere" ? "page" : null;
  if (answer === "everywhere") return portableChange(change) ? "everywhere" : "site";
  return "site";
}

let storageChain: Promise<unknown> = Promise.resolve();

function withStoredChanges<T>(work: () => Promise<T>): Promise<T> {
  const run = () => {
    const next = storageChain.then(work, work);
    storageChain = next.then(() => undefined, () => undefined);
    return next;
  };
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request("cappy-stored-changes", run);
  return run();
}

function placeChange(change: ActiveChange, scope: StoredScope, pagePath: string): ActiveChange {
  return { ...change, scope, pagePath: scope === "page" ? pagePath : undefined };
}

// The save prompt decides where a change lives. Only this origin and the everywhere list move; another site's copy of the same id stays.
export async function rescopeStoredChanges(origin: string, ids: readonly string[], answer: "hold" | "site" | "everywhere", pagePath: string) {
  if (!ids.length) return [];
  return withStoredChanges(async () => {
    const state = await load();
    const wanted = new Set(ids);
    const taken = new Map<string, ActiveChange>();
    const globalChanges = state.globalChanges.filter((change) => {
      if (!wanted.has(change.id)) return true;
      taken.set(change.id, change);
      return false;
    });
    let siteChanges = { ...state.siteChanges };
    const here = (siteChanges[origin] ?? []).filter((change) => {
      if (!wanted.has(change.id)) return true;
      if (!taken.has(change.id)) taken.set(change.id, change);
      return false;
    });
    siteChanges = writeSite(siteChanges, origin, here);
    const updates: Array<{ id: string; scope: StoredScope; pagePath?: string | null }> = [];
    const recipes = { ...state.recipes };
    for (const change of taken.values()) {
      const scope = scopeForPrompt(change, answer);
      const next = scope ? placeChange(change, scope, pagePath) : change;
      if (scope) updates.push({ id: next.id, scope: next.scope, pagePath: next.pagePath });
      if (next.scope === "everywhere") globalChanges.push(next);
      else siteChanges = writeSite(siteChanges, origin, [...(siteChanges[origin] ?? []), next]);
      if (!scope) continue;
      const prefix = `${origin}::`;
      for (const [key, recipe] of Object.entries(recipes)) {
        if (!key.startsWith(prefix) || !recipe.changes.some((item) => item.id === next.id)) continue;
        recipes[key] = { ...recipe, changes: recipe.changes.map((item) => (item.id === next.id ? placeChange(item, scope, pagePath) : item)) };
      }
    }
    await save({ globalChanges, siteChanges, recipes });
    return updates;
  });
}

export async function recordApplied(origin: string, change: ActiveChange) {
  await withStoredChanges(async () => {
    const state = await load();
    const site = without(state.siteChanges[origin] ?? [], change.id);
    const globalChanges = without(state.globalChanges, change.id);
    if (change.scope === "everywhere") globalChanges.push(change);
    else site.push(change);
    await save({ globalChanges, siteChanges: writeSite(state.siteChanges, origin, site) });
  });
}

export async function forgetStoredChange(host: string | null, id: string) {
  const state = await load();
  const siteChanges = { ...state.siteChanges };
  if (host != null) {
    const next = without(siteChanges[host] ?? [], id);
    if (next.length) siteChanges[host] = next;
    else delete siteChanges[host];
  }
  await save({ globalChanges: host == null ? without(state.globalChanges, id) : state.globalChanges, siteChanges });
}

export async function recordReverted(origin: string, id: string) {
  await withStoredChanges(async () => {
  const state = await load();
  const recipes = { ...state.recipes };
  const prefix = `${origin}::`;
  for (const [key, recipe] of Object.entries(recipes)) {
    if (!key.startsWith(prefix) || !recipe.changes.some((change) => change.id === id)) continue;
    const changes = recipe.changes.filter((change) => change.id !== id);
    if (changes.length) recipes[key] = { ...recipe, changes };
    else delete recipes[key];
  }
  await save({
    globalChanges: without(state.globalChanges, id),
    siteChanges: writeSite(state.siteChanges, origin, without(state.siteChanges[origin] ?? [], id)),
    recipes,
  });
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
