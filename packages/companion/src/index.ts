import { EMPTY_PROFILE, type LlmRequest, type LlmResponse, type Need, type Profile } from "@browser-agent/shared";
import { buildCompanionGraph } from "./graph";
import { IndexedDBSaver } from "./indexeddb-saver";

export type Llm = (req: LlmRequest) => Promise<LlmResponse>;

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type Proposal = { kind: "add_need"; need: Need; why: string };

export type CompanionView = {
  messages: ChatMessage[];
  profile: Profile;
  pending: Proposal | null;
};

export type Companion = {
  view(): Promise<CompanionView>;
  send(text: string): Promise<CompanionView>;
  decide(accept: boolean): Promise<CompanionView>;
};

export type CompanionOptions = { llm: Llm; threadId: string; dbName?: string };

/** LangGraph companion whose checkpoints live in IndexedDB, so a pending proposal survives a browser restart. */
export async function createCompanion(opts: CompanionOptions): Promise<Companion> {
  const graph = buildCompanionGraph(opts.llm, new IndexedDBSaver({ dbName: opts.dbName }));
  const config = { configurable: { thread_id: opts.threadId } };

  const view = async (): Promise<CompanionView> => {
    const { values } = await graph.getState(config);
    return {
      messages: values.messages ?? [],
      profile: values.profile ?? EMPTY_PROFILE,
      pending: values.pending ?? null,
    };
  };

  return {
    view,
    async send(text) {
      if ((await view()).pending) throw new Error("decide the pending proposal first");
      await graph.invoke({ messages: [{ role: "user", content: text }] }, config);
      return view();
    },
    async decide(accept) {
      if (!(await view()).pending) throw new Error("no pending proposal to decide");
      await graph.invoke({ decision: accept }, config);
      return view();
    },
  };
}
