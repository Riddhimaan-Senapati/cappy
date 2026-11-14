import { z } from "zod";
import { AdaptationId, EMPTY_PROFILE, PageStats, Profile, Screenshot, Verdict } from "@browser-agent/shared";

export const KEYS = {
  profile: "profile",
  installId: "installId",
  applied: "applied",
  last: "last",
} as const;

export const Applied = z.object({ adaptationId: AdaptationId, css: z.string() }).strict();
export type Applied = z.infer<typeof Applied>;
export const AppliedMap = z.record(z.string(), Applied);
export type AppliedMap = z.infer<typeof AppliedMap>;

export const LastResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      url: z.string(),
      tabId: z.number().int(),
      adaptationId: AdaptationId,
      reason: z.string(),
      blocks: z.array(z.string()),
      restored: z.boolean().optional(),
    })
    .strict(),
  z.object({ status: z.literal("undone"), url: z.string(), adaptationId: AdaptationId }).strict(),
  z.object({ status: z.literal("none"), url: z.string(), reason: z.string() }).strict(),
  z.object({ status: z.literal("blocked"), url: z.string(), reason: z.string() }).strict(),
  z.object({ status: z.literal("error"), url: z.string(), message: z.string() }).strict(),
]);
export type LastResult = z.infer<typeof LastResult>;

type AreaName = "local" | "session";

export async function readParsed<S extends z.ZodType>(
  area: AreaName,
  key: string,
  schema: S,
): Promise<z.output<S> | undefined> {
  const stored = await chrome.storage[area].get(key);
  const raw: unknown = stored[key];
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  return parsed.success ? (parsed.data as z.output<S>) : undefined;
}

export async function loadProfile(): Promise<Profile> {
  return (await readParsed("local", KEYS.profile, Profile)) ?? EMPTY_PROFILE;
}

export async function saveProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [KEYS.profile]: Profile.parse(profile) });
}

export async function getInstallId(): Promise<string> {
  const existing = await readParsed("local", KEYS.installId, z.string().min(1).max(100));
  if (existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [KEYS.installId]: id });
  return id;
}

export async function setLast(last: LastResult): Promise<void> {
  await chrome.storage.session.set({ [KEYS.last]: LastResult.parse(last) });
}

export const VERIFICATION_KEY = "verification";

export const VerificationState = z.enum([
  "proposed",
  "applied",
  "verifying",
  "retrying",
  "rolling_back",
  "verified",
  "rolled_back",
]);

export const Verification = z
  .object({
    adaptationId: AdaptationId,
    state: VerificationState,
    attempt: z.union([z.literal(1), z.literal(2)]).optional(),
    verdict: Verdict.optional(),
    notes: z.string().max(300).optional(),
    axeBefore: z.number().int().nonnegative(),
    axeAfter: z.number().int().nonnegative().optional(),
    statsBefore: PageStats.optional(),
    statsAfter: PageStats.optional(),
    before: Screenshot.optional(),
    after: Screenshot.optional(),
  })
  .strict();
export type Verification = z.infer<typeof Verification>;
