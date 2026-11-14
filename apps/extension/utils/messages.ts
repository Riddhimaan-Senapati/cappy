import { z } from "zod";
import { AdaptationId, BlockConfig, ContentFilter, PageOutline, PageStats, Rule, SnapshotOp } from "@browser-agent/shared";

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

export const GestureAction = z.enum(["scroll_down", "scroll_up", "back"]);
export type GestureAction = z.infer<typeof GestureAction>;

export const Gesture = z
  .object({ type: z.literal("gesture"), action: GestureAction, stepPx: z.number().int().min(50).max(1000) })
  .strict();
export type Gesture = z.infer<typeof Gesture>;

export const UserRequest = z
  .object({ type: z.literal("user-request"), text: z.string().trim().min(1).max(500) })
  .strict();
export type UserRequest = z.infer<typeof UserRequest>;

export const FrictionAccept = z.object({ type: z.literal("friction-accept") }).strict();

export const AdaptDone = z.object({ type: z.literal("adapt-done") }).strict();

export const FrictionPrompt = z
  .object({ type: z.literal("friction-prompt"), text: z.string().max(200) })
  .strict();

export const GetOutline = z.object({ type: z.literal("get-outline") }).strict();

export const OutlineReply = z.object({ url: z.string().max(2048), outline: PageOutline }).strict();
export type OutlineReply = z.infer<typeof OutlineReply>;
export const ApplyRuntime = z
  .object({ type: z.literal("apply-runtime"), adaptationId: AdaptationId, blocks: z.array(BlockConfig).max(6) })
  .strict();
export const UndoRuntime = z.object({ type: z.literal("undo-runtime") }).strict();
export const ApplyOps = z
  .object({ type: z.literal("apply-ops"), adaptationId: AdaptationId, ops: z.array(SnapshotOp).min(1).max(20) })
  .strict();
export const ApplyFilters = z
  .object({
    type: z.literal("apply-filters"),
    adaptationId: AdaptationId,
    filters: z.array(ContentFilter).min(1).max(6),
  })
  .strict();
export const ApplyFiltersReply = z.object({ matched: z.number().int().nonnegative() });
export const ApplyRules = z.object({ type: z.literal("apply-rules"), rules: z.array(Rule).max(50) }).strict();
export const AxeCount = z.object({ type: z.literal("axe-count") }).strict();
export const BannerNote = z.object({ type: z.literal("banner-note"), text: z.string().max(200) }).strict();
export const AxeCountReply = z.object({ count: z.number().int().nonnegative() });
export const PageStatsRequest = z.object({ type: z.literal("page-stats") }).strict();
export const PageStatsReply = z.object({ stats: PageStats });

export const ToContentMessage = z.discriminatedUnion("type", [
  ShowBanner,
  InjectSvg,
  RemoveBanner,
  AdaptDone,
  FrictionPrompt,
  GetOutline,
  Gesture,
  ApplyRuntime,
  UndoRuntime,
  BannerNote,
  AxeCount,
  ApplyOps,
  ApplyFilters,
  ApplyRules,
  PageStatsRequest,
]);
export type ToContentMessage = z.infer<typeof ToContentMessage>;

export const Message = z.discriminatedUnion("type", [
  PageReady,
  Undo,
  ShowBanner,
  InjectSvg,
  RemoveBanner,
  Gesture,
  UserRequest,
  FrictionAccept,
  ApplyRuntime,
  UndoRuntime,
  AxeCount,
]);
export type Message = z.infer<typeof Message>;
