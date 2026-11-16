import { REMOVABLE_ATTRIBUTES, SAFE_ATTRIBUTES, validateChange } from "../../shared/validate.js";
import { exportClassifyCaches, importClassifyCaches, load } from "./storage.js";

// A small hand-written parser instead of zod: the settings view is in the content script bundle, which must stay small.
// It keeps zod's rules here: required keys, nulls only where allowed, unknown keys dropped, finite numbers only.
type Parse<T> = (value: unknown) => T;
type Infer<P> = P extends Parse<infer T> ? T : never;
type Shape = Record<string, Parse<any>>;
type Out<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

const bad = (): never => {
  throw new Error("invalid");
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str: Parse<string> = (value) => (typeof value === "string" ? value : bad());
const bool: Parse<boolean> = (value) => (typeof value === "boolean" ? value : bad());
const num: Parse<number> = (value) => (typeof value === "number" && Number.isFinite(value) ? value : bad());
const lit = <T extends string | number>(expected: T): Parse<T> => (value) => (value === expected ? expected : bad());
const oneOf = <T extends string>(options: readonly T[]): Parse<T> => (value) => (options.includes(value as T) ? (value as T) : bad());
const range = (min: number, max: number): Parse<number> => (value) => {
  const n = num(value);
  return n >= min && n <= max ? n : bad();
};
const arr = <T>(item: Parse<T>): Parse<T[]> => (value) => (Array.isArray(value) ? value.map(item) : bad());
const rec = <T>(item: Parse<T>, keyOk: (key: string) => boolean = () => true): Parse<Record<string, T>> => (value) => {
  if (!isRecord(value)) return bad();
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => (keyOk(key) ? [key, item(entry)] : bad())));
};
const nullable = <T>(item: Parse<T>): Parse<T | null> => (value) => (value === null ? null : item(value));
const optional = <T>(item: Parse<T>): Parse<T | undefined> => (value) => (value === undefined ? undefined : item(value));
const nullish = <T>(item: Parse<T>): Parse<T | null | undefined> => (value) => (value == null ? (value as null | undefined) : item(value));
const trimmed: Parse<string> = (value) => {
  const text = str(value).trim();
  return text ? text : bad();
};
const obj = <S extends Shape>(shape: S): Parse<Out<S>> => (value) => {
  if (!isRecord(value)) return bad();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const parsed = shape[key](value[key]);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out as Out<S>;
};
const refine = <T>(item: Parse<T>, check: (value: T) => boolean): Parse<T> => (value) => {
  const parsed = item(value);
  return check(parsed) ? parsed : bad();
};
const union = <S extends Record<string, Parse<any>>>(key: string, options: S): Parse<Infer<S[keyof S]>> => (value) => {
  const tag = isRecord(value) ? value[key] : undefined;
  if (typeof tag !== "string" || !Object.hasOwn(options, tag)) return bad();
  return options[tag](value);
};

const strings = arr(str);
const DomOp = union("op", {
  addLabel: obj({ op: lit("addLabel"), selector: str, text: str }),
  setAttribute: obj({ op: lit("setAttribute"), selector: str, name: oneOf(SAFE_ATTRIBUTES), value: str }),
  removeAttribute: obj({ op: lit("removeAttribute"), selector: str, name: oneOf(REMOVABLE_ATTRIBUTES) }),
  pauseMedia: obj({ op: lit("pauseMedia"), selector: str }),
  reorder: obj({
    op: lit("reorder"),
    selector: str,
    keySelector: nullable(str),
    groupSelector: nullish(str),
    direction: oneOf(["asc", "desc"]),
    ranking: nullable(arr(obj({ key: str, rank: num }))),
    keywords: nullish(strings),
  }),
});
const BlockCall = union("name", {
  colorblind: obj({ name: lit("colorblind"), type: oneOf(["protanopia", "deuteranopia", "tritanopia"]), scope: oneOf(["media", "page"]) }),
  textScale: obj({ name: lit("textScale"), scale: num }),
  stopMotion: obj({ name: lit("stopMotion") }),
  darkMode: obj({ name: lit("darkMode"), allowSiteControls: bool }),
  contrast: obj({ name: lit("contrast"), minRatio: num }),
  formFixer: obj({ name: lit("formFixer"), minTargetPx: num, addLabels: bool, clearErrors: bool, oneQuestionMode: bool }),
  contentFilter: obj({
    name: lit("contentFilter"),
    keywords: strings,
    itemSelector: nullable(str),
    match: nullish(str),
    action: oneOf(["hide", "dim"]),
  }),
});
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const Schedule = obj({
  days: nullish(arr(oneOf(DAYS))),
  start: nullish(str),
  end: nullish(str),
  from: nullish(str),
  until: nullish(str),
  untilAt: nullish(str),
});
const changeFields = {
  id: str,
  summary: str,
  reason: str,
  css: nullable(str),
  dom: nullable(arr(DomOp)),
  block: nullable(BlockCall),
  scope: oneOf(["page", "site", "everywhere"]),
  pagePath: nullish(str),
  schedule: optional(nullable(Schedule)),
};
const change = refine(obj({ ...changeFields, appliedAt: num, targetLabel: optional(str) }), (value) => !validateChange(value));

const profileFields = {
  profile: strings,
  pendingMemory: strings,
  pendingSites: rec(obj({ host: str, scope: oneOf(["site", "everywhere"]) })),
  history: arr(obj({ role: oneOf(["user", "assistant"]), text: str })),
  submittedRequests: strings,
  requestSessions: arr(obj({
    message: str, reply: str, outcome: oneOf(["done", "error"]), thread: optional(str),
    options: optional(obj({ question: str, options: arr(obj({ label: str, request: str })) })),
  })),
  globalChanges: arr(change),
  siteChanges: rec(arr(change)),
  recipes: rec(obj({ message: str, changes: arr(change), at: num })),
  commands: arr(obj({ id: str, name: str, prompt: str, everywhere: bool, appliedOrigins: strings, createdAt: num })),
  nudgedAt: rec(num),
  suggestionFeedback: arr(obj({
    text: str, host: str, at: num,
    outcome: oneOf(["accepted-site", "accepted-everywhere", "accepted", "dismissed", "undone"]),
  })),
};
const profile = obj(profileFields);

const settings = refine(obj({
  ...profileFields,
  activeProfileId: str,
  profiles: rec(obj({ name: trimmed, state: optional(profile) })),
  siteSkills: rec(obj({ notes: strings, updatedAt: num })),
  camera: obj({
    enabled: bool, handScroll: bool, headScroll: bool, pointer: bool,
    swipeNav: optional(bool), speakAfterSelect: optional(bool), dwellMs: range(0, Infinity),
  }),
  paused: bool,
  proactive: bool,
  floatingButton: bool,
  routing: oneOf(["auto", "fast", "frontier"]),
  provider: nullable(str),
  modelChoices: rec(obj({ fast: optional(str), frontier: optional(str) })),
  speakReplies: bool,
  ttsVoice: str,
  ttsRate: range(0.5, 2),
  voiceAutoSend: bool,
  voiceLang: str,
}), (value) => Object.hasOwn(value.profiles, value.activeProfileId)
  && Object.entries(value.profiles).every(([id, entry]) => id === value.activeProfileId || entry.state !== undefined));

// Files exported before the rename to Cappy say "browser-agent-config" and still import.
const classifyCache = optional(rec(obj({
  version: num,
  matches: rec(rec(obj({ verdict: bool, at: num }))),
}), (key) => /^classifyCache:\S+$/.test(key)));

const config = obj({
  format: oneOf(["cappy-config", "browser-agent-config"]),
  version: lit(1),
  settings,
  classifyCache,
});
export type ImportedConfig = Infer<typeof settings> & { classifyCache?: Infer<typeof classifyCache> };

export async function exportConfig(): Promise<string> {
  const [state, caches] = await Promise.all([load(), exportClassifyCaches()]);
  return JSON.stringify({ format: "cappy-config", version: 1, settings: settings(state), classifyCache: caches }, null, 2);
}

export function parseConfig(text: string): ImportedConfig {
  try {
    const parsed = config(JSON.parse(text));
    return { ...parsed.settings, ...(parsed.classifyCache ? { classifyCache: parsed.classifyCache } : {}) };
  } catch {
    throw new Error("Invalid config file. Choose a JSON file exported by Cappy (version 1).");
  }
}

export async function importConfig(imported: ImportedConfig): Promise<void> {
  const { classifyCache: caches, ...settings } = imported;
  // Keep this computer's server connection and credentials. Audio must be verified here.
  await chrome.storage.local.set({
    ...settings,
    voiceProvider: "chrome",
    openAIVoiceVerified: false,
    geminiVoiceVerified: false,
    configImportedAt: Date.now(),
  });
  if (caches) await importClassifyCaches(caches);
}
