import { z } from "zod";

export const NeedKind = z.enum(["color_vision", "light_sensitivity", "text_size", "motor", "focus"]);
export type NeedKind = z.infer<typeof NeedKind>;

export const NeedId = z.string().min(1).max(40).brand<"NeedId">();
export type NeedId = z.infer<typeof NeedId>;

export const Need = z
  .object({
    id: NeedId,
    kind: NeedKind,
    detail: z.string().min(1).max(200),
    source: z.enum(["onboarding", "friction", "sentient"]),
  })
  .strict();
export type Need = z.infer<typeof Need>;

export const Profile = z
  .object({
    version: z.number().int().nonnegative(),
    summary: z.string().max(600),
    needs: z.array(Need).max(20),
  })
  .strict();
export type Profile = z.infer<typeof Profile>;

export const EMPTY_PROFILE: Profile = { version: 0, summary: "", needs: [] };
