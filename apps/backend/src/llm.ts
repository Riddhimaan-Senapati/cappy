import type { LlmRequest, LlmResponse } from "@browser-agent/shared";

export type LlmClient = (req: LlmRequest) => Promise<LlmResponse>;
