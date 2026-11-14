import { useEffect, useState } from "react";
import { Verification, VERIFICATION_KEY } from "../../utils/state";

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

function useVerification(): Verification | undefined {
  const [value, setValue] = useState<Verification | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void chrome.storage.session.get(VERIFICATION_KEY).then((stored: Record<string, unknown>) => {
      if (alive) setValue(parseVerification(stored[VERIFICATION_KEY]));
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && VERIFICATION_KEY in changes) {
        setValue(parseVerification(changes[VERIFICATION_KEY]?.newValue));
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return value;
}

export function VerifyPanel() {
  const verification = useVerification();
  const [showBefore, setShowBefore] = useState(false);

  if (!verification) {
    return (
      <section className="card" aria-labelledby="h-did-it-help">
        <h2 id="h-did-it-help">Did it help?</h2>
        <p>No change has been checked yet.</p>
      </section>
    );
  }

  const v = verification;
  const shot = showBefore ? v.before : v.after;

  return (
    <section className="card" aria-labelledby="h-did-it-help">
      <h2 id="h-did-it-help">Did it help?</h2>
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
        <strong>Issues:</strong> {v.axeBefore} -&gt; {v.axeAfter ?? "pending"}
      </p>

      <div className="row">
        <button
          type="button"
          aria-pressed={showBefore}
          disabled={!v.before}
          onClick={() => setShowBefore((prev) => !prev)}
        >
          Before
        </button>
        <span className="muted">Showing {showBefore ? "before" : "after"}</span>
      </div>

      {shot ? (
        <img
          src={shot}
          alt={showBefore ? "Page before the change" : "Page after the change"}
          style={{ width: "100%", marginTop: 8, border: "1px solid #c7c7cc", borderRadius: 6 }}
        />
      ) : (
        <p className="muted">{showBefore ? "No before screenshot." : "The after screenshot is not ready yet."}</p>
      )}
    </section>
  );
}
