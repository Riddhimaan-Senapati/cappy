import type { Tier } from "../../../shared/protocol.js";
import type { AgentSession } from "../session.js";

export interface AgentProvider {
  name: string;
  label?: string;
  models: Record<Tier, string>;
  run(session: AgentSession, tier: Tier, model: string): Promise<string>;
  listModels?(): Promise<string[]>;
  complete(system: string, user: string, model: string): Promise<string>;
}
