import type { AdaptRequest, AdaptResponse } from "@browser-agent/shared";

export type Adapter = (req: AdaptRequest) => Promise<AdaptResponse>;
