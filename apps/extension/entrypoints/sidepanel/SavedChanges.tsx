import { useEffect, useState } from "react";
import { forget, parseSaved, readSaved, updateSaved, SAVED_KEY, type SavedChanges as Saved } from "../../utils/saved-changes";

export function SavedChanges() {
  const [saved, setSaved] = useState<Saved>({});

  useEffect(() => {
    let alive = true;
    const load = () => void readSaved().then((next) => alive && setSaved(next));
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && SAVED_KEY in changes) setSaved(parseSaved(changes[SAVED_KEY]));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const hosts = Object.entries(saved).sort(([, a], [, b]) => b.savedAt - a.savedAt);
  if (hosts.length === 0) return <p>No changes are saved. A verified change is kept for its site and replayed on the next visit.</p>;

  return (
    <ul className="saved-list">
      {hosts.map(([host, entry]) => (
        <li key={host}>
          <span>
            <strong>{host}</strong>
            <span className="muted"> {entry.adaptation.reason.text}</span>
          </span>
          <button
            type="button"
            className="secondary"
            aria-label={`Forget the saved change for ${host}`}
            onClick={() => void updateSaved((s) => forget(s, host))}
          >
            Forget
          </button>
        </li>
      ))}
    </ul>
  );
}
