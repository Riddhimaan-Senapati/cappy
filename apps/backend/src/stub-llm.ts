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

const PREFERENCE = /\bi (?:prefer|like|love|hate|don't like|do not like|always want|never want)\b[^.!?]{2,120}/i;

function preferenceProposal(text: string) {
  const match = PREFERENCE.exec(text);
  if (!match) return null;
  const detail = match[0].replace(/^i\s+/i, "").trim();
  return {
    reply: `Got it, I'll keep that in mind: ${detail}.`,
    proposal: { kind: "preference", detail, why: "You told me this preference" },
  };
}

export function stubReply(req: LlmRequest): LlmResponse {
  if (!req.jsonSchema) return { text: PLAIN_REPLY };
  const message = lastUserMessage(req);
  const proposal = COLOR_BLIND.test(message)
    ? COLOR_PROPOSAL
    : preferenceProposal(message) ?? { reply: PLAIN_REPLY, proposal: null };
  return { text: JSON.stringify(proposal) };
}

export const stubLlm: LlmClient = async (req) => stubReply(req);
