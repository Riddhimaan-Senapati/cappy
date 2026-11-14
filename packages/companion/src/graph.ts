import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { EMPTY_PROFILE, NeedId, NeedKind, type Profile } from "@browser-agent/shared";
import { z } from "zod";
import type { ChatMessage, Llm, Proposal } from "./index";

const SYSTEM_PROMPT = [
  "You are an accessibility onboarding companion helping one user describe their needs.",
  "Ask short, friendly questions about color vision, light sensitivity, text size, motor limits, and focus.",
  "When the user states a need, put it in `proposal` (kind, detail, why). Otherwise set `proposal` to null.",
  "Lasting tastes and habits that are not one of those needs are kind \"preference\", with the user's words as detail, e.g. \"prefers dark mode\", \"likes long-form videos\", \"no spoilers for Formula 1\".",
  "Only propose things the user will want every time, never a one-off page request like \"hide this sidebar\".",
  'Reply with JSON only: {"reply": string, "proposal": null | {"kind": one of the listed kinds, "detail": string, "why": string}}.',
].join("\n");

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    proposal: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...NeedKind.options] },
            detail: { type: "string" },
            why: { type: "string" },
          },
          required: ["kind", "detail", "why"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["reply", "proposal"],
  additionalProperties: false,
};

const ReplySchema = z.object({
  reply: z.string(),
  proposal: z
    .object({ kind: NeedKind, detail: z.string().min(1).max(200), why: z.string() })
    .nullable(),
});
type Reply = z.infer<typeof ReplySchema>;

function parseReply(text: string): Reply {
  // Models often wrap JSON in a code fence even when asked not to.
  const unfenced = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed = ReplySchema.safeParse(JSON.parse(unfenced));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: fall through and show the raw text as the reply.
  }
  return { reply: text, proposal: null };
}

const State = Annotation.Root({
  messages: Annotation<ChatMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  profile: Annotation<Profile>({ value: (_left, right) => right, default: () => EMPTY_PROFILE }),
  pending: Annotation<Proposal | null>({ value: (_left, right) => right, default: () => null }),
  decision: Annotation<boolean | null>({ value: (_left, right) => right, default: () => null }),
});

export function buildCompanionGraph(llm: Llm, checkpointer: BaseCheckpointSaver) {
  const chat = async (state: typeof State.State) => {
    const history = state.messages.slice(-20).map(({ role, content }) => ({ role, content }));
    const res = await llm({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      jsonSchema: REPLY_SCHEMA,
    });
    const parsed = parseReply(res.text);
    const proposal: Proposal | null = parsed.proposal
      ? {
          kind: "add_need",
          need: {
            id: NeedId.parse(crypto.randomUUID().slice(0, 8)),
            kind: parsed.proposal.kind,
            detail: parsed.proposal.detail,
            source: "onboarding",
          },
          why: parsed.proposal.why,
        }
      : null;
    return {
      messages: [{ role: "assistant" as const, content: parsed.reply }],
      pending: proposal,
    };
  };

  const applyDecision = (state: typeof State.State) => {
    const proposal = state.pending;
    if (!proposal) throw new Error("apply_decision reached without a pending proposal");
    if (state.decision) {
      const { need } = proposal;
      return {
        profile: {
          ...state.profile,
          version: state.profile.version + 1,
          needs: [...state.profile.needs, need],
        },
        messages: [{ role: "assistant" as const, content: `Saved: ${need.detail}` }],
        pending: null,
        decision: null,
      };
    }
    return {
      messages: [{ role: "assistant" as const, content: "Okay, I won't save that." }],
      pending: null,
      decision: null,
    };
  };

  const route = (state: typeof State.State) =>
    state.decision !== null && state.pending !== null ? "apply_decision" : "chat";

  return new StateGraph(State)
    .addNode("chat", chat)
    .addNode("apply_decision", applyDecision)
    .addConditionalEdges(START, route, ["apply_decision", "chat"])
    .addEdge("chat", END)
    .addEdge("apply_decision", END)
    .compile({ checkpointer });
}
