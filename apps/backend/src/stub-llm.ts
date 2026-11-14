import type { LlmRequest, LlmResponse } from "@browser-agent/shared";
import type { LlmClient } from "./llm";

const PLAIN_REPLY = "Thanks. I noted that.";
const COLOR_BLIND = /colou?r[- ]?blind/i;

const COLOR_PROPOSAL = {
  reply: "Noted. I can adjust colors for red-green colorblindness.",
  proposal: {
    kind: "color_vision",
    detail: "red-green colorblind",
    why: "You said you are colorblind",
  },
};

export function lastUserMessage(req: LlmRequest): string {
  const user = req.messages.filter((m) => m.role === "user").at(-1);
  return user?.content ?? "";
}

export function stubReply(req: LlmRequest): LlmResponse {
  if (!req.jsonSchema) return { text: PLAIN_REPLY };
  const proposal = COLOR_BLIND.test(lastUserMessage(req))
    ? COLOR_PROPOSAL
    : { reply: PLAIN_REPLY, proposal: null };
  return { text: JSON.stringify(proposal) };
}

export const stubLlm: LlmClient = async (req) => stubReply(req);
