import type { MemoryScope } from "../../../shared/protocol.js";
import { acceptProposal, rejectProposal } from "../memory.js";

export type MemoryOutcome = { saved: true; scope: MemoryScope } | { saved: false };

export interface ScopeChoice {
  label: string;
  suggested: boolean;
  run(): Promise<MemoryOutcome>;
}

// The agent's suggested scope comes first, so the default action matches what the user asked for.
export function scopeChoices(lines: readonly string[], host: string | undefined, suggested: MemoryScope = "everywhere"): ScopeChoice[] {
  const accept = (scope: MemoryScope) => async (): Promise<MemoryOutcome> => {
    for (const line of lines) await acceptProposal(line, scope);
    return { saved: true, scope };
  };
  const site: ScopeChoice | null = host ? { label: `Only on ${host}`, suggested: suggested === "site", run: accept("site") } : null;
  const everywhere: ScopeChoice = { label: "All sites", suggested: suggested !== "site" || !host, run: accept("everywhere") };
  const skip: ScopeChoice = {
    label: "Don't save",
    suggested: false,
    run: async () => {
      for (const line of lines) await rejectProposal(line);
      return { saved: false };
    },
  };
  const saves = site ? (suggested === "site" ? [site, everywhere] : [everywhere, site]) : [everywhere];
  return [...saves, skip];
}

export function outcomeText(outcome: MemoryOutcome, host: string | undefined) {
  if (!outcome.saved) return "Not saved";
  return outcome.scope === "site" && host ? `Saved for ${host}` : "Saved for all sites";
}
