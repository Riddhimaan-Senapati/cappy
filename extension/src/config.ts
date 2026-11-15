import { z } from "zod";
import { Change, validateChange } from "../../shared/adaptation.js";
import { exportClassifyCaches, importClassifyCaches, load } from "./storage.js";

const strings = z.array(z.string());
const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value);
const change = Change.extend({ appliedAt: z.number(), targetLabel: z.string().optional() })
  .refine((value) => !validateChange(value), "Invalid saved change");
const profile = z.object({
  profile: strings,
  pendingMemory: strings,
  pendingSites: record(z.object({ host: z.string(), scope: z.enum(["site", "everywhere"]) })),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })),
  submittedRequests: strings,
  requestSessions: z.array(z.object({
    message: z.string(), reply: z.string(), outcome: z.enum(["done", "error"]), thread: z.string().optional(),
    options: z.object({ question: z.string(), options: z.array(z.object({ label: z.string(), request: z.string() })) }).optional(),
  })),
  globalChanges: z.array(change),
  siteChanges: record(z.array(change)),
  recipes: record(z.object({ message: z.string(), changes: z.array(change), at: z.number() })),
  commands: z.array(z.object({
    id: z.string(), name: z.string(), prompt: z.string(), everywhere: z.boolean(), appliedOrigins: strings, createdAt: z.number(),
  })),
  nudgedAt: record(z.number()),
  suggestionFeedback: z.array(z.object({
    text: z.string(), host: z.string(), at: z.number(),
    outcome: z.enum(["accepted-site", "accepted-everywhere", "accepted", "dismissed", "undone"]),
  })),
});

const settings = profile.extend({
  activeProfileId: z.string(),
  profiles: record(z.object({ name: z.string().trim().min(1), state: profile.optional() })),
  siteSkills: record(z.object({ notes: strings, updatedAt: z.number() })),
  camera: z.object({
    enabled: z.boolean(), handScroll: z.boolean(), headScroll: z.boolean(), pointer: z.boolean(),
    swipeNav: z.boolean().optional(), speakAfterSelect: z.boolean().optional(), dwellMs: z.number().nonnegative(),
  }),
  paused: z.boolean(),
  proactive: z.boolean(),
  floatingButton: z.boolean(),
  routing: z.enum(["auto", "fast", "frontier"]),
  provider: z.string().nullable(),
  modelChoices: record(z.object({ fast: z.string().optional(), frontier: z.string().optional() })),
  speakReplies: z.boolean(),
  ttsVoice: z.string(),
  ttsRate: z.number().min(0.5).max(2),
  voiceAutoSend: z.boolean(),
  voiceLang: z.string(),
}).refine((value) => Object.hasOwn(value.profiles, value.activeProfileId)
  && Object.entries(value.profiles).every(([id, entry]) => id === value.activeProfileId || entry.state),
"Invalid profiles");

// Files exported before the rename to Cappy say "browser-agent-config" and still import.
const classifyCache = z.record(z.string(), z.object({
  version: z.number(),
  matches: z.record(z.string(), z.record(z.string(), z.object({ verdict: z.boolean(), at: z.number() }))),
})).optional();

const config = z.object({ format: z.enum(["cappy-config", "browser-agent-config"]), version: z.literal(1), settings, classifyCache });
export type ImportedConfig = z.infer<typeof settings> & { classifyCache?: z.infer<typeof classifyCache> };

export async function exportConfig(): Promise<string> {
  const [state, caches] = await Promise.all([load(), exportClassifyCaches()]);
  return JSON.stringify({ format: "cappy-config", version: 1, settings: settings.parse(state), classifyCache: caches }, null, 2);
}

export function parseConfig(text: string): ImportedConfig {
  try {
    const parsed = config.parse(JSON.parse(text));
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
