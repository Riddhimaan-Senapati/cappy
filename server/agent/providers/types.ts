import type { AgentSession } from "../session.js";

export interface AgentProvider {
  name: string;
  model: string;
  run(session: AgentSession): Promise<string>;
}
