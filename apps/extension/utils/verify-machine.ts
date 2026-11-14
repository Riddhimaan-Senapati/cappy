export type Verdict = "improved" | "no_change" | "worse";
export type Attempt = 1 | 2;

export type VerifyState =
  | { tag: "proposed" }
  | { tag: "applied"; attempt: Attempt }
  | { tag: "verifying"; attempt: Attempt }
  | { tag: "retrying" }
  | { tag: "rolling_back" }
  | { tag: "verified"; attempt: Attempt }
  | { tag: "rolled_back" };

export type VerifyEvent =
  | { type: "applied" }
  | { type: "verify_started" }
  | { type: "verdict"; verdict: Verdict }
  | { type: "retry_done" }
  | { type: "rollback_done" };

export function next(state: VerifyState, event: VerifyEvent): VerifyState {
  switch (state.tag) {
    case "proposed":
      if (event.type === "applied") return { tag: "applied", attempt: 1 };
      break;
    case "applied":
      if (event.type === "verify_started") return { tag: "verifying", attempt: state.attempt };
      break;
    case "verifying":
      if (event.type === "verdict") {
        if (event.verdict === "improved") return { tag: "verified", attempt: state.attempt };
        if (state.attempt === 1) return { tag: "retrying" };
        return { tag: "rolling_back" };
      }
      break;
    case "retrying":
      if (event.type === "retry_done") return { tag: "applied", attempt: 2 };
      // The retry could not be re-applied, so there is nothing left to verify.
      if (event.type === "rollback_done") return { tag: "rolled_back" };
      break;
    case "rolling_back":
      if (event.type === "rollback_done") return { tag: "rolled_back" };
      break;
    case "verified":
    case "rolled_back":
      break;
  }
  throw new Error(`invalid verify transition: ${state.tag} on ${event.type}`);
}

export function isTerminal(state: VerifyState): boolean {
  return state.tag === "verified" || state.tag === "rolled_back";
}
