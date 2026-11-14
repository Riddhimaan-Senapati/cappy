import { useState } from "react";
import { statChanges } from "../../utils/page-stats";
import { Verification, VERIFICATION_KEY } from "../../utils/state";
import { useStored } from "./hooks";

const STATE_LABELS: Record<Verification["state"], string> = {
  proposed: "Proposed",
  applied: "Applied",
  verifying: "Checking the result",
  retrying: "Retrying once",
  rolling_back: "Rolling back",
  verified: "Verified: it helped",
  rolled_back: "Rolled back: it did not help",
};

const VERDICT_LABELS: Record<NonNullable<Verification["verdict"]>, string> = {
  improved: "Improved",
  no_change: "No change",
  worse: "Worse",
};

const parseVerification = (raw: unknown) => {
  const parsed = Verification.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

// Rendered inside the agent bubble of the latest run; renders nothing until a change has been checked.
export function VerifyPanel() {
  const v = useStored("session", VERIFICATION_KEY, parseVerification);
  const [showBefore, setShowBefore] = useState(false);
  if (!v) return null;

  const shot = showBefore ? v.before : v.after;
  const changes = v.statsBefore && v.statsAfter ? statChanges(v.statsBefore, v.statsAfter) : [];

  return (
    <section className="verify" aria-labelledby="h-did-it-help">
      <h4 id="h-did-it-help">Did it help?</h4>
      <p>
        <strong>{STATE_LABELS[v.state]}</strong>
        {v.attempt === 2 && <span className="muted"> (second try)</span>}
      </p>
      {v.verdict && (
        <p>
          <strong>Verdict:</strong> {VERDICT_LABELS[v.verdict]}
        </p>
      )}
      {v.notes && <p className="muted">{v.notes}</p>}
      <p>
        <strong>Issues:</strong> {v.axeBefore} → {v.axeAfter ?? "pending"}
      </p>
      {changes.length > 0 && (
        <ul className="verify-stats">
          {changes.map((change) => (
            <li key={change.label}>
              {change.label} {change.before} → {change.after}
            </li>
          ))}
        </ul>
      )}
      <div className="toggle-row">
        <button type="button" aria-pressed={showBefore} disabled={!v.before} onClick={() => setShowBefore((prev) => !prev)}>
          Before
        </button>
        <span className="muted">Showing {showBefore ? "before" : "after"}</span>
      </div>
      {shot ? (
        <img className="verify-shot" src={shot} alt={showBefore ? "Page before the change" : "Page after the change"} />
      ) : (
        <p className="muted">{showBefore ? "No before screenshot." : "The after screenshot is not ready yet."}</p>
      )}
    </section>
  );
}
