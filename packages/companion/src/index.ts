import type { LlmRequest, LlmResponse, Need, Profile } from "@browser-agent/shared";

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
export async function createCompanion(_opts: CompanionOptions): Promise<Companion> {
  throw new Error("not implemented");
}
