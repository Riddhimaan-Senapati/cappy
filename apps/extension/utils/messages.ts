import { z } from "zod";
import { AdaptationId, PageOutline } from "@browser-agent/shared";

export const PageReady = z
  .object({ type: z.literal("page-ready"), url: z.string().max(2048), outline: PageOutline })
  .strict();
export type PageReady = z.infer<typeof PageReady>;

export const Undo = z.object({ type: z.literal("undo"), adaptationId: AdaptationId }).strict();

export const ShowBanner = z
  .object({ type: z.literal("show-banner"), reason: z.string().max(200), adaptationId: AdaptationId })
  .strict();

export const InjectSvg = z.object({ type: z.literal("inject-svg"), svg: z.string().max(20000) }).strict();

export const RemoveBanner = z.object({ type: z.literal("remove-banner") }).strict();

export const ToContentMessage = z.discriminatedUnion("type", [ShowBanner, InjectSvg, RemoveBanner]);
export type ToContentMessage = z.infer<typeof ToContentMessage>;

export const Message = z.discriminatedUnion("type", [PageReady, Undo, ShowBanner, InjectSvg, RemoveBanner]);
export type Message = z.infer<typeof Message>;
